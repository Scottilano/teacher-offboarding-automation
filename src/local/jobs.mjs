import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isValidEmail } from '../normalize.mjs';
import { runAuditedAction, TERMINAL_RESULTS, writeLocalAudit } from '../audit.mjs';
import { openSiteSession } from '../browser.mjs';
import { ArclcAdapter } from '../platforms/arclc.mjs';
import { AhaAdapter } from '../platforms/aha.mjs';
import { checkSession } from '../session-check.mjs';
import { protectedExclusions, teacherProtection, assertNotProtected, batchLimit } from '../protection.mjs';
import {persistEvidence} from '../evidence.mjs';

const idPattern = /^[0-9a-f-]{36}$/;
const retryable = new Set(['PENDING', 'READY']);
export const DEFERRABLE = new Set(['MANUAL_REVIEW','ERROR','UNVERIFIED','INTERRUPTED','LOGIN_REQUIRED']);
const stamp = () => new Date().toISOString();

export class JobStore {
  constructor(directory) { this.directory = directory; }
  file(id) {
    if (!idPattern.test(id)) throw new Error('Invalid job ID.');
    return path.join(this.directory, id + '.json');
  }
  async save(job) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    job.updatedAt = stamp();
    const file = this.file(job.id), temp = file + '.' + randomUUID() + '.tmp';
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(job, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    // Windows does not expose directory handles through fs.open; file was synced above.
    if(process.platform !== 'win32') {
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  async load(id) {
    const job = JSON.parse(await readFile(this.file(id), 'utf8'));
    if (job.id !== id || job.schemaVersion !== 1 || !Array.isArray(job.items)) throw new Error('The local job file is invalid or corrupted.');
    return job;
  }
  async list() {
    const files = await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const jobs = [];
    for (const file of files.filter(f => idPattern.test(f.slice(0, -5)) && f.endsWith('.json'))) {
      try {
        const job = await this.load(file.slice(0, -5));
        jobs.push({ id: job.id, fileName: job.source.fileName, updatedAt: job.updatedAt, total: job.items.length, completed: job.items.filter(i => TERMINAL_RESULTS.has(i.status)).length });
      } catch { /* A damaged file is never executed automatically. */ }
    }
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
  }
}

export function createJob(roster, platforms, config, excludedEmails = []) {
  if (!roster.accepted.length || roster.rejected.length) throw new Error('The roster contains invalid records or no valid teachers. Correct it and import again.');
  if (!Array.isArray(platforms) || !platforms.length || new Set(platforms).size !== platforms.length || platforms.some(p => !['arclc', 'aha'].includes(p) || !config.sites[p]?.enabled)) throw new Error('Select valid platforms.');
  // Resolve operator choices against the server-owned preview, never client rows.
  const knownEmails = new Set(roster.accepted.map(t => t.email));
  if (!Array.isArray(excludedEmails) || new Set(excludedEmails).size !== excludedEmails.length || excludedEmails.some(email => typeof email !== 'string' || !knownEmails.has(email))) throw new Error('Invalid exclusions. Review the preview again.');
  const excluded = new Set([...excludedEmails, ...protectedExclusions(roster, config).map(t => t.email)]);
  const included = roster.accepted.filter(t => !excluded.has(t.email));
  if (!included.length) throw new Error('All teachers are excluded. Include at least one teacher, or do not save this job.');
  return {
    schemaVersion: 1, id: randomUUID(), createdAt: stamp(), source: structuredClone(roster.source),
    scope: 'Process only included teachers from the imported roster. ARCLC: ALLCPR Inc. / Instructor only. AHA: ALLCPR / Instructor (32238), checking All, Active and Expired views.',
    excludedTeachers: roster.accepted.filter(t => excluded.has(t.email)).map(t => ({
      ...structuredClone(t), platforms: [...platforms], status: 'EXCLUDED', excludedAt: stamp(),
      protected: !!teacherProtection(t, config),
      detail: teacherProtection(t, config)
        ? 'Automatically excluded on both platforms by configured protection: ' + teacherProtection(t, config).reason + ' No website inspection or removal performed; not counted as complete.'
        : 'Manually excluded from this job during import. No website inspection or removal performed; not counted as complete.'
    })),
    items: platforms.flatMap(platform => included.map(teacher => ({
      ...structuredClone(teacher), platform, action: 'UNALIGN', status: 'PENDING', detail: 'Pending',
      ...(platform === 'arclc' ? { organization: 'ALLCPR Inc.' } : { organizationId: String(config.sites.aha.organizationId) })
    })))
  };
}

export function validateJob(job, config) {
  if (!job.items.length || job.items.length > 20000) throw new Error('Invalid number of job items.');
  const exclusions = job.excludedTeachers ?? [];
  if (!Array.isArray(exclusions) || exclusions.length > 10000) throw new Error('Invalid exclusion records.');
  const excludedEmails = new Set();
  for (const teacher of exclusions) {
    if (!isValidEmail(teacher?.email) || excludedEmails.has(teacher.email) || teacher.status !== 'EXCLUDED') throw new Error('Invalid exclusion records.');
    excludedEmails.add(teacher.email);
  }
  const keys = new Set();
  for (const item of job.items) {
    const key = item.platform + ':' + item.email;
    if (!['arclc', 'aha'].includes(item.platform) || !config.sites[item.platform]?.enabled ||
        item.action !== 'UNALIGN' || !isValidEmail(item.email) || item.email !== item.email.trim().toLowerCase() ||
        typeof item.fullName !== 'string' || !item.fullName.trim() || keys.has(key) || excludedEmails.has(item.email) ||
        (item.platform === 'arclc' && (item.organization !== 'ALLCPR Inc.' || config.sites.arclc.organizationLabel !== 'ALLCPR Inc.')) ||
        (item.platform === 'aha' && item.organizationId !== String(config.sites.aha.organizationId))) throw new Error('Invalid job scope, organization or teacher identity. No website action performed.');
    keys.add(key);
  }
}

export class LocalCoordinator {
  constructor(config, { store, openSession = openSiteSession, adapterFactory, sessionChecker = checkSession } = {}) {
    this.config = config;
    this.store = store || new JobStore(path.join(config.runtime.baseDir, 'data/local-jobs'));
    this.openSession = openSession;
    this.sessionChecker = sessionChecker;
    this.loginStates = {};
    this.adapterFactory = adapterFactory || ((platform, page) => new (platform === 'arclc' ? ArclcAdapter : AhaAdapter)(config, page));
    this.sessions = new Map();
    this.active = null;
    this.busy = false;
    this.running = null;
    this.lastError = '';
    this.closing = false;
  }
  state() {
    return { busy: this.busy, active: this.active, lastError: this.lastError, loginStates: this.loginStates,
      browsers: [...this.sessions].filter(([, session]) => !session.page.isClosed()).map(([platform]) => platform) };
  }
  async applyConfiguredDeferrals() {
    // Called at startup, before accepting requests and after the single-app lock.
    // An operator approval binds one existing task, email, platform and reason;
    // it is not a global skip rule for future imports or other manual results.
    for (const decision of this.config.localManualReviewDeferrals || []) {
      let job;
      try { job = await this.store.load(decision.jobId); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      validateJob(job, this.config);
      const matches = job.items.filter(i => i.email === decision.email && i.platform === decision.platform);
      if (matches.length !== 1) continue;
      const item = matches[0];
      if (item.status !== 'MANUAL_REVIEW' || item.detail !== decision.expectedDetail || !decision.reason) continue;
      await writeLocalAudit(this.config, { runId: job.id, email: item.email, platform: item.platform, fullName: item.fullName,
        action: 'DEFER_FOR_MANUAL_REVIEW', result: 'DEFERRED', previousStatus: item.status, previousDetail: item.detail, detail: decision.reason });
      item.deferredFrom = { status: item.status, detail: item.detail };
      item.status = 'DEFERRED';
      item.deferredAt = stamp();
      item.detail = `Deferred for manual review; not counted as complete. ${decision.reason} Previous result: ${item.deferredFrom.detail}`;
      await this.store.save(job);
    }
  }
  async session(platform) {
    let session = this.sessions.get(platform);
    if (!session || session.page.isClosed()) {
      session = await this.openSession(platform, this.config);
      this.sessions.set(platform, session);
    }
    return session;
  }
  async login(platform) {
    if (!['arclc', 'aha'].includes(platform)) throw new Error('Invalid platform.');
    if (this.busy) throw new Error('An operation is already running.');
    if (this.closing) throw new Error('The app is shutting down.');
    this.busy = true;
    this.running = (async () => {
      try {
        const { page } = await this.session(platform);
        this.loginStates[platform] = { status: 'CHECKING', detail: 'Refreshing the protected page to verify the session.' };
        this.loginStates[platform] = await this.sessionChecker(platform, this.config, page, { openLogin: true });
        this.lastError = this.loginStates[platform].status === 'READY' ? '' : this.loginStates[platform].detail;
      } finally { this.busy = false; }
    })();
    await this.running;
  }
  async getJob(id) {
    const job = await this.store.load(id);
    if (this.active?.id !== id) {
      let changed = false;
      for (const item of job.items) if (['RUNNING', 'CHECKING'].includes(item.status)) {
        item.status = 'INTERRUPTED';
        item.detail = 'The previous process was interrupted; the outcome is unknown. Use Inspect Unfinished Items before attempting another submission.';
        changed = true;
      }
      if (changed) await this.store.save(job);
    }
    return job;
  }
  async start(id, mode, limit, confirmation) {
    if (this.closing) throw new Error('The app is shutting down.');
    if (this.busy) throw new Error('An operation is already running; another cannot be started.');
    if (!['execute', 'inspect'].includes(mode)) throw new Error('Invalid operation.');
    if (!Number.isInteger(limit) || limit < 1 || limit > batchLimit(this.config, [])) throw new Error(`Choose 1–${batchLimit(this.config, [])} platform actions per batch.`);
    if (mode === 'execute' && confirmation !== `UNALIGN:${id}`) throw new Error('The current job has not been authorized.');
    this.busy = true;
    try {
      const job = await this.getJob(id);
      validateJob(job, this.config);
      const remaining = job.items.filter(item => !TERMINAL_RESULTS.has(item.status) && item.status !== 'DEFERRED');
      // Includes pre-existing jobs: importing again is required to drop protected entries.
      for (const item of remaining) assertNotProtected(item, this.config);
      const maximum = batchLimit(this.config, [...new Set(remaining.map(i => i.platform))]);
      if (limit > maximum) throw new Error(`This job allows up to ${maximum} platform actions per batch, using the lowest limit among pending platforms.`);
      if (mode === 'execute') {
        if (remaining.some(i => !retryable.has(i.status))) throw new Error('Failed or uncertain items remain. Inspect unfinished items first.');
        for (const platform of new Set(remaining.map(i => i.platform))) {
          if (this.config.sites[platform].implementationStatus !== 'ready' || (platform === 'aha' && !this.config.sites.aha.coverageVerified)) throw new Error(`${platform.toUpperCase()} has not passed acceptance. This job supports inspection only, not removal.`);
        }
      }
      // Inspections target unresolved items before already READY items, so retry can advance.
      const candidates = mode === 'inspect' ? remaining.filter(i => i.status !== 'READY') : remaining;
      const items = candidates.slice(0, limit);
      if (!items.length) throw new Error(mode === 'inspect' ? 'No items need inspection. READY items were inspected and still require authorization before removal.' : 'This job has no remaining actions.');
      for (const platform of new Set(items.map(i => i.platform))) {
        const session = this.sessions.get(platform);
        if (!session || session.page.isClosed()) throw new Error(`Open the ${platform.toUpperCase()} sign-in window and finish signing in first.`);
      }
      this.active = { id, mode, total: items.length, completed: 0, currentEmail: '', stopRequested: false };
      this.lastError = '';
      this.running = this.perform(job, items, mode).catch(error => { this.lastError = error.message; })
        .finally(() => { this.active = null; this.busy = false; });
      return { started: true };
    } catch (error) { this.busy = false; throw error; }
  }
  async defer(id, decision) {
    if(this.busy || this.closing) throw new Error('Cannot defer while an operation is running or the app is shutting down.');
    this.busy=true;
    this.running=(async()=>{
      const job=await this.getJob(id); validateJob(job,this.config);
      const item=job.items.find(i=>i.email===decision.email && i.platform===decision.platform);
      if(!item || !DEFERRABLE.has(item.status)) throw new Error('Only unresolved items requiring review in this job can be deferred.');
      if(decision.confirmation!==`DEFER:${id}:${item.platform}:${item.email}` || decision.expectedStatus!==item.status ||
        decision.expectedDetail!==item.detail || decision.expectedCheckedAt!==(item.checkedAt||'')) throw new Error('The item changed or was not confirmed. Refresh the job and review it again.');
      if(typeof decision.reason!=='string' || !decision.reason.trim() || decision.reason.length>500 || /[\x00-\x1f\x7f]/.test(decision.reason)) throw new Error('Enter a single-line deferral reason of 1–500 characters.');
      const reason=decision.reason.trim();
      await writeLocalAudit(this.config,{runId:id,platform:item.platform,email:item.email,fullName:item.fullName,
        action:'DEFER_FOR_MANUAL_REVIEW',result:'DEFERRED',previousStatus:item.status,previousDetail:item.detail,detail:reason});
      item.deferredFrom={status:item.status,detail:item.detail,checkedAt:item.checkedAt||''};
      item.status='DEFERRED';item.deferredAt=stamp();item.deferReason=reason;
      item.detail='Deferred by the user for this platform and job; not counted as complete. Any earlier submission still requires manual verification. Reason: '+reason+' Previous result: '+item.deferredFrom.detail;
      await this.store.save(job); this.lastError='';
      return job;
    })().finally(()=>{this.busy=false;});
    return this.running;
  }
  async perform(job, items, mode) {
    for (const item of items) {
      if (this.active.stopRequested) break;
      this.active.currentEmail = item.email;
      if(item.evidencePath) item.previousEvidencePath=item.evidencePath;
      delete item.evidence; delete item.evidencePath;
      item.status = mode === 'execute' ? 'RUNNING' : 'CHECKING';
      item.detail = mode === 'execute' ? 'Executing and verifying. Do not close the automated browser.' : 'Inspecting without submitting a removal.';
      await this.store.save(job); // Crash leaves RUNNING: never inferred as success.
      const { page } = this.sessions.get(item.platform);
      const adapter = this.adapterFactory(item.platform, page);
      let result;
      this.loginStates[item.platform] = { status: 'CHECKING', detail: 'Checking the session before processing this teacher.' };
      const sessionStatus = await this.sessionChecker(item.platform, this.config, page, { openLogin: true });
      this.loginStates[item.platform] = sessionStatus;
      if (sessionStatus.status !== 'READY') {
        result = { status: 'LOGIN_REQUIRED', detail: sessionStatus.detail + ' No removal submitted for this teacher. Sign in, inspect unfinished items, then authorize again.' };
      } else if (mode === 'execute') {
        // Local-only path: no Google module or Sheet calls, even if credentials exist.
        result = await runAuditedAction({ config: this.config, item: { ...item, source: job.source }, runId: job.id, action: () => adapter.unalign(item) });
      } else {
        try { result = await adapter.inspect(item); }
        catch (error) { result = { status: 'ERROR', detail: error.message }; }
        result=await persistEvidence(this.config,item,result,job.id);
      }
      item.status = result.status;
      item.detail = result.detail;
      item.checkedAt = stamp();
      if(result.evidence){item.evidence=result.evidence;item.evidencePath=result.evidencePath;}
      await this.store.save(job);
      this.active.completed++;
      if (!TERMINAL_RESULTS.has(result.status) && !(mode === 'inspect' && result.status === 'READY')) {
        this.lastError = `Stopped at ${item.email}: ${result.status}. Review the details and inspect again.`;
        break;
      }
    }
  }
  stop() { if (this.active) this.active.stopRequested = true; }
  async close() {
    this.closing = true;
    this.stop();
    if (this.running) await this.running.catch(() => {});
    await Promise.all([...this.sessions.values()].map(s => s.context.close().catch(() => {})));
  }
}

export function jobCsv(job) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [['Full Name', 'Email', 'Platform', 'Organization', 'Source Rows', 'Result', 'Detail', 'Checked At', 'Evidence File'],
    ...job.items.map(i => [i.fullName, i.email, i.platform, i.organization || i.organizationId, i.sourceRows.join(','), i.status, i.detail, i.checkedAt || '', i.evidencePath || '']),
    ...(job.excludedTeachers || []).flatMap(i => i.platforms.map(platform => [i.fullName, i.email, platform,
      job.items.find(item => item.platform === platform)?.organization || job.items.find(item => item.platform === platform)?.organizationId || '',
      i.sourceRows.join(','), 'EXCLUDED', i.detail, '', '']))]
    .map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export async function saveJobCsv(job, reportsDir) {
  if (!idPattern.test(job.id)) throw new Error('Invalid job ID.');
  const directory = path.join(reportsDir, 'results');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'offboarding-' + job.id + '.csv');
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(jobCsv(job)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  return file;
}
