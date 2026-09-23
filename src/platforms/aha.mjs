import { PlatformAdapter } from './base.mjs';
import { assertNotProtected } from '../protection.mjs';
import { observeAction } from '../action-observer.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { visibleSessionProblem, openLoginEntry } from '../session-check.mjs';

const STATUSES = ['ALL', 'ACTIVE', 'EXPIRED'];
const DISCIPLINES = ['BLS', 'Heartsaver'];
const normalize = value => String(value || '').trim().toLowerCase();
const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x));
const nameMismatch = (view, item) => view.row && item.fullName &&
  compact(view.row.fullName).toLowerCase() !== compact(item.fullName).toLowerCase();

// Never include search email, authentication parameters or unknown values in errors.
export function ahaScopeSummary(address) {
  const url = new URL(address);
  const safe = ['orgId', 'roleId', 'roleName', 'expiryStatus', 'applyTsFilter', 'page', 'pageSize'];
  return { origin: url.origin, path: url.pathname,
    parameters: Object.fromEntries(safe.map(key => [key, url.searchParams.getAll(key)])),
    otherParameterNames: [...new Set(url.searchParams.keys())].filter(key => !safe.includes(key)) };
}

// Only public, observed Atlas UI parameters. Extra filters could conceal an alignment.
export function ahaInstructorUrl(email, organizationId, status = 'ALL') {
  if (!STATUSES.includes(status)) throw new Error('Unsupported AHA status view.');
  const url = new URL('https://atlas.heart.org/manage-Instructor');
  url.search = new URLSearchParams({
    sortBy: 'lastName', sortDir: 'asc', page: '1', pageSize: '50',
    nameOrEmailOrInstructorId: normalize(email), roleId: '17', roleName: 'INSTRUCTOR',
    orgId: String(organizationId), expiryStatus: status, applyTsFilter: 'true'
  }).toString();
  return url.href;
}

export function assertAhaScope(address, site, { requireCoverage = false, status } = {}) {
  const url = new URL(address);
  const allowed = new Set(['sortBy', 'sortDir', 'page', 'pageSize', 'nameOrEmailOrInstructorId',
    'roleId', 'roleName', 'orgId', 'expiryStatus', 'applyTsFilter']);
  const single = key => url.searchParams.getAll(key).length === 1 ? url.searchParams.get(key) : null;
  if (url.origin !== 'https://atlas.heart.org' || url.pathname !== '/manage-Instructor' ||
      !/^\d+$/.test(String(site.organizationId)) || single('orgId') !== String(site.organizationId) ||
      single('roleId') !== '17' || single('roleName') !== 'INSTRUCTOR' || single('applyTsFilter') !== 'true' ||
      [...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) {
    throw new Error('AHA company/Instructor scope or filters changed. No removal is permitted. Scope: ' + JSON.stringify(ahaScopeSummary(address)));
  }
  if (!STATUSES.includes(single('expiryStatus')) || (status && single('expiryStatus') !== status)) {
    throw new Error('AHA status-filter coverage does not match the requested view.');
  }
  if (requireCoverage && (site.coverageVerified !== true || single('expiryStatus') !== 'ALL')) {
    throw new Error('AHA All-status coverage is not validated. No removal or global absence claim is permitted.');
  }
}

// Runs against the rendered table, not application state or private endpoints.
// Headers are excluded by their cells, not by position (mobile tables have no header row).
export function readAhaTable(table) {
  return [...table.querySelectorAll('tr')].filter(row => row.querySelector('td[data-title="Email Address"]')).map(row => {
    const title = column => row.querySelector('td[data-title="' + column + '"] [title]')?.getAttribute('title') || '';
    return {
      email: title('Email Address').trim().toLowerCase(),
      fullName: title('Instructor').trim(),
      organization: title('Organization').trim(),
      disciplines: [...row.querySelectorAll('td[data-title="Discipline"] [class*="dynamicTable_disciplineIcon__"]')].map(block => ({
        name: (block.querySelector('[class*="dynamicTable_spanStyle"], [class*="dynamicTable_spanTagStyling__"]')?.textContent || '').trim(),
        status: (block.querySelector('[class*="dynamicTable_status__"]')?.textContent || '').trim(),
        hasActiveSince: /Active Since/.test(block.textContent || '')
      }))
    };
  });
}

export function classifyAhaTeacher(records, email) {
  const matches = records.filter(row => normalize(row.email) === normalize(email));
  if (!matches.length) return { status: 'ABSENT_IN_VIEW', detail: 'No exact email in the complete requested view.' };
  if (matches.length !== 1) return { status: 'MANUAL_REVIEW', detail: 'Multiple exact AHA email matches; no selection is safe.' };
  const row = matches[0];
  if (row.organization !== 'ALLCPR' || !row.fullName || !row.disciplines?.length ||
      new Set(row.disciplines.map(d => d.name)).size !== row.disciplines.length ||
      row.disciplines.some(d => !DISCIPLINES.includes(d.name) || !['', 'Expired', 'Not Aligned'].includes(d.status) || !d.hasActiveSince)) {
    return { status: 'MANUAL_REVIEW', detail: 'Unknown AHA organization, discipline or status layout; do not infer alignment.' };
  }
  const disciplines = row.disciplines.filter(d => d.status !== 'Not Aligned').map(d => d.name);
  return { status: disciplines.length ? 'READY' : 'UNALIGNED_IN_VIEW', row, disciplines,
    detail: disciplines.length ? 'Exact email in ALLCPR; aligned disciplines: ' + disciplines.join(', ') :
      'Historical row retained, with every discipline explicitly Not Aligned.' };
}

// Atlas places the visible label over the native checkbox. Click that associated
// label normally, then verify native checked state; never force-click or mutate DOM.
export async function selectAhaDisciplines(dialog, expected) {
  const boxes = dialog.getByRole('checkbox');
  const read = () => boxes.evaluateAll(nodes => nodes.map(node => ({
    id: node.id, checked: node.checked, disabled: node.disabled,
    labels: [...(node.labels || [])].map(label => ({ text: (label.textContent || '').trim(), for: label.htmlFor }))
  })));
  const initial = await read();
  const names = initial.map(box => box.labels.length === 1 ? box.labels[0].text : '');
  if (!sameSet(names, expected) || new Set(initial.map(box => box.id)).size !== initial.length ||
      initial.some(box => box.checked || box.disabled || !/^[A-Za-z][A-Za-z0-9 _-]*$/.test(box.id) ||
        box.labels.length !== 1 || box.labels[0].for !== box.id)) {
    throw new Error('AHA checkbox/label identities are ambiguous or preselected. Remove was not clicked.');
  }
  const selected = [];
  for (const name of expected) {
    const target = initial[names.indexOf(name)];
    const label = dialog.locator('label[for=' + JSON.stringify(target.id) + ']');
    if (await label.count() !== 1) throw new Error('AHA label is not unique. Remove was not clicked.');
    await label.click({ timeout: 5000 });
    selected.push(name);
    let confirmed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await read();
      if (JSON.stringify(current.map(box => ({ id: box.id, labels: box.labels }))) !==
          JSON.stringify(initial.map(box => ({ id: box.id, labels: box.labels })))) {
        throw new Error('AHA checkbox identities changed during selection. Remove was not clicked.');
      }
      const checked = current.filter(box => box.checked).map(box => box.labels[0].text);
      if (checked.some(value => !selected.includes(value))) {
        throw new Error('AHA selected an unexpected discipline. Remove was not clicked.');
      }
      if (sameSet(checked, selected)) { confirmed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!confirmed) throw new Error('AHA checkbox did not remain selected after clicking its label. Remove was not clicked.');
  }
}

export class AhaAdapter extends PlatformAdapter {
  constructor(config, page) { super('aha', config, page); }
  table() { return this.page.getByRole('table', { name: 'Manage Instructors', exact: true }); }

  async searchExactRows(email, status = 'ALL') {
    this.assertInspectable();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalize(email))) throw new Error('A valid exact email is required.');
    // Fresh full navigation discards stale rows and resets every visibility filter.
    await this.page.goto(ahaInstructorUrl(email, this.config.sites.aha.organizationId, status), { waitUntil: 'domcontentloaded' });
    const table = this.table();
    await table.waitFor({ state: 'visible', timeout: 30000 }).catch(async () => {
      await openLoginEntry('aha', this.config, this.page);
      throw new Error('AHA session is unverified or the instructor page is unavailable. Sign-in navigation was attempted. Sign in through the automated browser, then inspect unfinished items. No removal was automatically retried.');
    });
    const input = this.page.getByRole('textbox', { name: 'Search', exact: true });
    await input.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
      throw new Error('AHA desktop Search control unavailable. Keep the automation browser at its configured desktop size.');
    });
    // Atlas renders controls/table shells before its company/filter state is ready.
    // Do not click Search during hydration: it may overwrite URL scope with defaults.
    this.lastSearchStage = 'WAITING_FOR_INITIAL_COMPANY_VIEW';
    await this.waitForSearchView(email, status, false);
    this.lastSearchStage = 'APPLYING_EXACT_EMAIL_SEARCH';
    await input.fill(normalize(email));
    await this.page.getByRole('button', { name: 'Search', exact: true }).click();
    this.lastSearchStage = 'WAITING_FOR_SEARCH_RESULTS';
    return this.waitForSearchView(email, status, true);
  }

  async waitForSearchView(email, status, requireInput) {
    const table = this.table();
    const input = this.page.getByRole('textbox', { name: 'Search', exact: true });
    let previous = '', stable = 0, lastIssue = '';
    for (let attempt = 0; attempt < 60; attempt++) {
      try { assertAhaScope(this.page.url(), this.config.sites.aha, { status }); }
      catch (error) {
        lastIssue = error.message;
        stable = 0;
        await this.page.waitForTimeout(500);
        continue; // Read-only wait; never repair or waive a wrong company/role.
      }
      const applied = (!requireInput || normalize(await input.inputValue()) === normalize(email)) &&
        normalize(new URL(this.page.url()).searchParams.get('nameOrEmailOrInstructorId')) === normalize(email);
      const records = await table.evaluate(readAhaTable);
      const alerts = (await this.page.getByRole('alert').allTextContents()).join(' ');
      const totals = [...alerts.matchAll(/items?\s*of\s*(\d+)/gi)].map(match => Number(match[1]));
      const complete = records.length === 0 ? /No Results Found/i.test(alerts) :
        totals.length === 1 && totals[0] === records.length;
      const role = await this.page.getByRole('combobox', { name: 'Role', exact: true }).evaluate(el => el.closest('[title]')?.getAttribute('title'));
      const filter = await this.page.getByRole('combobox', { name: 'Alignment Status', exact: true }).evaluate(el => el.closest('[title]')?.getAttribute('title'));
      const controlsMatch = role === 'Instructor' && filter?.toUpperCase() === status;
      const signature = JSON.stringify({ records, alerts, role, filter });
      stable = applied && complete && controlsMatch && signature === previous ? stable + 1 : 0;
      lastIssue = !controlsMatch ? 'Visible company role/status controls are not ready.' :
        !complete ? 'Table result count is incomplete or still loading.' :
        !applied ? 'Search email has not been applied.' : 'Result has not yet stabilized.';
      previous = signature;
      if (stable >= 4) {
        if (records.some(row => row.organization !== 'ALLCPR' || !row.email)) {
          throw new Error('AHA result rows are not unambiguously bound to ALLCPR.');
        }
        return records;
      }
      await this.page.waitForTimeout(500);
    }
    throw new Error('AHA view did not become ready. No absence or removal inferred. ' + lastIssue +
      ' Stage: ' + this.lastSearchStage + '. Scope: ' + JSON.stringify(ahaScopeSummary(this.page.url())));
  }

  async inspectMany(items) {
    const results = [];
    for (const item of items) results.push({ item, ...await this.inspect(item) });
    return results;
  }

  async openUnalignDialog(email, view) {
    assertAhaScope(this.page.url(), this.config.sites.aha, { status: 'ALL' });
    const fresh = classifyAhaTeacher(await this.table().evaluate(readAhaTable), email);
    if (fresh.status !== 'READY' || JSON.stringify(fresh.row) !== JSON.stringify(view.row)) {
      throw new Error('AHA target row changed before selection.');
    }
    const rows = this.table().locator('tr').filter({ has: this.page.locator('td[data-title="Email Address"]') });
    const records = await this.table().evaluate(readAhaTable);
    const index = records.findIndex(row => normalize(row.email) === normalize(email));
    const row = rows.nth(index);
    const title = await row.locator('td[data-title="Email Address"] [title]').first().getAttribute('title');
    if (normalize(title) !== normalize(email)) throw new Error('AHA row identity changed.');
    await row.getByRole('button', { name: 'More Action', exact: true }).click();
    await row.getByRole('button', { name: 'Unalign', exact: true }).click();
    const dialog = this.page.locator('#UnalignInstructor[role="dialog"]');
    await dialog.waitFor({ state: 'visible' });
    const boxes = dialog.getByRole('checkbox');
    const labels = await boxes.evaluateAll(nodes => nodes.map(node => (node.labels?.[0]?.textContent || '').trim()));
    await this.assertDialog(dialog, view);
    if (!sameSet(labels, view.disciplines) || await boxes.evaluateAll(nodes => nodes.some(node => node.checked || node.disabled))) {
      throw new Error('AHA dialog disciplines differ from the exact target row, or were preselected. Nothing submitted.');
    }
    const removeButton = dialog.locator('button[title="Remove Alignment"]');
    if (await removeButton.count() !== 1) throw new Error('AHA final Remove Alignment button is missing or ambiguous.');
    return { dialog, boxes, removeButton };
  }

  async assertDialog(dialog, view) {
    const text = compact(await dialog.innerText());
    if (!text.includes('Remove alignment for ' + view.row.fullName) ||
        !text.includes('Choose which disciplines to remove alignment for ' + view.row.fullName + ' from ALLCPR.')) {
      throw new Error('AHA removal dialog does not identify the expected teacher and ALLCPR.');
    }
  }

  async inspect(item) {
    const view = classifyAhaTeacher(await this.searchExactRows(item.email), item.email);
    if (nameMismatch(view, item)) return { status: 'MANUAL_REVIEW', detail: 'Exact email matched, but the AHA name differs from the source roster. No removal permitted.' };
    if (view.status === 'MANUAL_REVIEW') return view;
    if (view.status !== 'READY') return this.verifyAbsent(item.email);
    const { dialog } = await this.openUnalignDialog(item.email, view);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    return { status: 'READY', detail: view.detail };
  }

  async verifyAbsent(email, expectedDisciplines = []) {
    if (this.config.sites.aha.coverageVerified !== true) {
      return { status: 'MANUAL_REVIEW', detail: 'AHA All-status coverage has not been approved.' };
    }
    const evidence = STATUSES.map(filter=>({filter,status:'NOT_CHECKED',organizationId:String(this.config.sites.aha.organizationId),role:'INSTRUCTOR'}));
    for (const status of STATUSES) {
      const index=STATUSES.indexOf(status);
      try {
      const records = await this.searchExactRows(email, status);
      assertAhaScope(this.page.url(), this.config.sites.aha, { status, requireCoverage: status === 'ALL' });
      const view = classifyAhaTeacher(records, email);
      evidence[index]={...evidence[index],...view,recordCount:records.length,checkedAt:new Date().toISOString()};
      if (view.status === 'MANUAL_REVIEW') return { ...view, evidence };
      if (view.status === 'READY' || (status !== 'ALL' && view.status !== 'ABSENT_IN_VIEW')) {
        return { status: 'UNVERIFIED', detail: 'AHA still shows a target alignment in the ' + status + ' view.', evidence };
      }
      if (status === 'ALL' && view.row && expectedDisciplines.some(name =>
        !view.row.disciplines.some(d => d.name === name && d.status === 'Not Aligned'))) {
        return { status: 'UNVERIFIED', detail: 'AHA historical row does not confirm every requested discipline as Not Aligned.', evidence };
      }
      } catch(error) {
        evidence[index]={...evidence[index],status:'READ_FAILED',checkedAt:new Date().toISOString(),detail:'View loading, session or scope verification failed.'};
        return {status:'UNVERIFIED',detail:'AHA '+status+' view verification is incomplete; absence cannot be inferred. '+error.message,evidence};
      }
    }
    return { status: 'ABSENT_VERIFIED', detail: 'Fresh ALL, ACTIVE and EXPIRED searches confirm no target Instructor alignment in ALLCPR; historical Not Aligned rows are permitted.', evidence };
  }

  async unalign(item) {
    assertNotProtected(item, this.config);
    this.assertReady();
    const view = classifyAhaTeacher(await this.searchExactRows(item.email), item.email);
    assertAhaScope(this.page.url(), this.config.sites.aha, { requireCoverage: true });
    if (nameMismatch(view, item)) return { status: 'MANUAL_REVIEW', detail: 'Exact email matched, but the AHA name differs from the source roster. No removal permitted.' };
    if (view.status === 'MANUAL_REVIEW') return view;
    if (view.status !== 'READY') return this.verifyAbsent(item.email);
    const { dialog, boxes, removeButton } = await this.openUnalignDialog(item.email, view);
    try { await selectAhaDisciplines(dialog, view.disciplines); }
    catch (error) {
      return { status: 'MANUAL_REVIEW', detail: 'Discipline selection could not be verified. The final Remove Alignment button was not clicked. ' + error.message };
    }
    const checked = await boxes.evaluateAll(nodes => nodes.filter(node => node.checked).map(node => (node.labels?.[0]?.textContent || '').trim()));
    if (!sameSet(checked, view.disciplines)) throw new Error('AHA selected disciplines are not exactly the approved target disciplines.');
    const directory = path.join(this.config.runtime.reportsDir, 'diagnostics');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'aha-result-' + Date.now() + '.json');
    await writeFile(file, JSON.stringify({ email: item.email, before: view, stage: 'BEFORE_SUBMIT' }, null, 2), { mode: 0o600 });
    const observer = observeAction(this.page, { platform: 'aha', confirmDialog: this.config.runtime.confirmDialog,
      allowedConfirmMessages: this.config.sites.aha.allowedConfirmMessages || [] });
    let result;
    try {
      assertAhaScope(this.page.url(), this.config.sites.aha, { requireCoverage: true });
      await this.assertDialog(dialog, view);
      if (await visibleSessionProblem(this.page)) throw new Error('A session-expiry prompt appeared. Remove was not clicked. Sign in again and inspect.');
      await removeButton.click();
      await observer.settle();
      if (observer.sessionExpired || await visibleSessionProblem(this.page)) result = { status: 'UNVERIFIED', detail: 'Session expired or access was restricted during submission; outcome unknown. Sign in and inspect before resubmitting.' };
      else if (observer.blocked) result = { status: 'UNVERIFIED', detail: 'Unexpected native dialog was dismissed; inspect diagnostics before any retry.' };
      else if (!await observer.waitForQuiet()) result = { status: 'UNVERIFIED', detail: 'AHA removal request did not settle; not resubmitted.' };
      else {
        await dialog.waitFor({ state: 'hidden', timeout: 30000 });
        result = await this.verifyAbsent(item.email, view.disciplines);
        if (result.status === 'ABSENT_VERIFIED') result = { ...result, status: 'REMOVED',
          detail: 'Removed ' + view.disciplines.join(', ') + '; refreshed All/Active/Expired views confirm no target alignment.' };
      }
    } catch (error) {
      result = { status: 'UNVERIFIED', detail: error.message + ' Submission may have occurred; inspect before retrying.' };
    } finally { await observer.stop(); }
    await writeFile(file, JSON.stringify({ email: item.email, before: view, result, events: observer.events }, null, 2), { mode: 0o600 });
    return { ...result, detail: result.detail + ' Diagnostics: ' + file };
  }
}
