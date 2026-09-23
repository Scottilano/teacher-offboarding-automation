import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadConfig } from '../config.mjs';
import { importRoster } from './import.mjs';
import {importLimits} from './limits.mjs';
import { LocalCoordinator, createJob, saveJobCsv } from './jobs.mjs';
import { protectedExclusions, batchLimit } from '../protection.mjs';
import {revealResult} from './reveal.mjs';

const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/execution-state.js': ['execution-state.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const assets = fileURLToPath(new URL('../../ui/', import.meta.url));

async function bodyJson(request, maxBytes) {
  let size = 0;
  const chunks = [];
  if (!String(request.headers['content-type']).startsWith('application/json')) throw new Error('A JSON request is required.');
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('The request exceeds the size limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startLocalServer({ config, coordinator = new LocalCoordinator(config), token = randomBytes(32).toString('hex'), port = 0, revealFile } = {}) {
  const limits = importLimits(config);
  await coordinator.applyConfiguredDeferrals();
  const previews = new Map();
  let origin;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (code, value, type = 'application/json; charset=utf-8') => {
      response.writeHead(code, { 'Content-Type': type });
      response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return send(403, { error: 'Only the local app interface may access this service.' });
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && staticFiles[url.pathname]) {
        const [name, type] = staticFiles[url.pathname];
        return send(200, await readFile(path.join(assets, name)), type);
      }
      const credential = Buffer.from(String(request.headers.authorization || ''));
      const expected = Buffer.from('Bearer ' + token);
      if (credential.length !== expected.length || !timingSafeEqual(credential, expected)) return send(401, { error: 'Invalid local session. Reopen the complete URL shown by the launcher.' });
      if (request.method === 'GET' && url.pathname === '/api/state') return send(200, {
        ...coordinator.state(),
        previewExclusionVersion: 1,
        protectedExclusionVersion: 1,
        deferredReviewVersion: 1,
        revealResultVersion: process.platform === 'darwin' || revealFile ? 1 : 0,
        protectedTeachers: config.safety.protectedTeachers || [],
        sites: Object.fromEntries(['arclc', 'aha'].map(p => [p, { enabled: config.sites[p].enabled, maxBatch: batchLimit(config, [p]), ready: config.sites[p].implementationStatus === 'ready' && (p !== 'aha' || config.sites.aha.coverageVerified) }])),
        maxBatch: batchLimit(config, []), maxFileMb: limits.maxFileMb, maxFileBytes: limits.maxFileBytes, reportsDir: config.runtime.reportsDir
      });
      if (request.method === 'GET' && url.pathname === '/api/jobs') return send(200, await coordinator.store.list());
      if (request.method === 'GET' && url.pathname === '/api/job') return send(200, await coordinator.getJob(url.searchParams.get('id')));
      if (request.method !== 'POST') return send(404, { error: 'Request not found.' });
      const body = await bodyJson(request, url.pathname === '/api/import' ? limits.maxRequestBytes : 12 * 1024 * 1024);
      if (url.pathname === '/api/stop') { coordinator.stop(); return send(200, { stopping: true }); }
      if (url.pathname === '/api/export') return send(200, { filePath: await saveJobCsv(await coordinator.getJob(body.id), config.runtime.reportsDir) });
      if (url.pathname === '/api/reveal-result') {
        await coordinator.store.load(body.id);
        return send(200,await revealResult(body.id,config.runtime.reportsDir,revealFile));
      }
      if (coordinator.busy) throw new Error('An operation is running. Wait or request a stop.');
      if (url.pathname === '/api/import') {
        if (typeof body.dataBase64 !== 'string' || body.dataBase64.length > Math.ceil(limits.maxFileBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.dataBase64)) throw new Error('Invalid file encoding or file size.');
        const roster = await importRoster({ fileName: body.fileName, bytes: Buffer.from(body.dataBase64, 'base64'), sheetName: body.sheetName }, config);
        if (roster.needsSheet) return send(200, roster);
        const previewId = randomUUID();
        while (previews.size >= 3) previews.delete(previews.keys().next().value);
        previews.set(previewId, roster);
        return send(200, { previewId, ...roster, protectedExclusions: protectedExclusions(roster, config) });
      }
      if (url.pathname === '/api/create') {
        const roster = previews.get(body.previewId);
        if (!roster) throw new Error('This preview has expired. Import the file again.');
        const job = createJob(roster, body.platforms, config, body.excludedEmails);
        await coordinator.store.save(job);
        previews.delete(body.previewId);
        return send(200, job);
      }
      if (url.pathname === '/api/login') { await coordinator.login(body.platform); return send(200, { opened: true }); }
      if (url.pathname === '/api/defer') return send(200,await coordinator.defer(body.id,body));
      if (url.pathname === '/api/start') return send(200, await coordinator.start(body.id, body.mode, body.limit, body.confirmation));
      return send(404, { error: 'Request not found.' });
    } catch (error) { if (!response.headersSent) send(400, { error: error.message }); }
  });
  server.requestTimeout = 120000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, coordinator, url: origin + '/#' + token, origin, token,
    async close() { await coordinator.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}

export async function acquireAppLock(baseDir) {
  const file = path.join(baseDir, 'data/local-app.lock');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid)); await handle.sync(); await handle.close();
      return () => unlink(file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid startup lock. Check data/local-app.lock before restarting.');
      try { process.kill(pid, 0); }
      catch (status) { if (status.code === 'ESRCH') { await unlink(file); continue; } throw status; }
      throw new Error('The app is already running. Use the existing window, or press Ctrl+C in its terminal before restarting.');
    }
  }
  throw new Error('Unable to acquire the startup lock.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if(Number(process.versions.node.split('.')[0])<22) throw new Error('Node 22 or newer is required. Run npm run doctor to check your environment.');
  const baseDir = fileURLToPath(new URL('../../', import.meta.url));
  const config = await loadConfig(path.join(baseDir, 'config.json'), { localOnly: true });
  config.runtimeCredentials = { arclc: { username: '', password: '' }, aha: { username: '', password: '' } };
  process.umask(0o077);
  const release = await acquireAppLock(baseDir);
  let app;
  try { app = await startLocalServer({ config }); }
  catch (error) { await release(); throw error; }
  console.log(`\nTeacher Offboarding (Local Edition)\n${app.url}\n\nKeep this terminal open. Press Ctrl+C to exit; the current teacher will finish verification first.\nNo Google Sheets are read or updated. Do not share this session URL.`);
  if (!process.argv.includes('--no-open') && process.platform === 'darwin') execFile('open', [app.url], () => {});
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('Stopping; browsers will close after the current teacher finishes verification.');
    try { await app.close(); } finally { await release(); }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
