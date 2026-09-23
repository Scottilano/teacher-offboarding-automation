import { executionState } from './execution-state.js';
const $ = id => document.getElementById(id);
const sessionKey = 'offboarding-local-token';
let token = location.hash.slice(1) || sessionStorage.getItem(sessionKey) || '';
if (location.hash) { sessionStorage.setItem(sessionKey, token); history.replaceState(null, '', location.pathname); }
let preview = null, job = null, state = null, polling = false, wasBusy = false;
const excludedEmails = new Set();
let creating = false, importing = false, importGeneration = 0, pendingDeferral = null, lastExportJob = null;
let starting = false;
const canDefer = status => ['MANUAL_REVIEW','ERROR','UNVERIFIED','INTERRUPTED','LOGIN_REQUIRED'].includes(status);
const done = status => ['REMOVED', 'ABSENT_VERIFIED'].includes(status);
const labels = { PENDING: 'Pending', READY: 'Ready', RUNNING: 'Running', CHECKING: 'Inspecting', REMOVED: 'Removed', ABSENT_VERIFIED: 'Verified absent', ERROR: 'Error', UNVERIFIED: 'Unverified', MANUAL_REVIEW: 'Manual review', DEFERRED: 'Deferred for manual review', INTERRUPTED: 'Interrupted' };
labels.LOGIN_REQUIRED = 'Sign-in required';
async function api(route, body, raw = false) {
  const response = await fetch('/api/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Request failed'); }
  return raw ? response.text() : response.json();
}
function message(text, error = false) {
  $('message').hidden = !text; $('message').className = error ? 'error' : ''; $('message').textContent = text;
  $('action-message').hidden = !error || !job;
  $('action-message').textContent = error ? text : '';
}
function cell(row, text, className) { const td = document.createElement('td'); td.textContent = text; if (className) td.className = className; row.append(td); }
function lockedJob() { return job?.items.some(i => !done(i.status) && i.status !== 'DEFERRED' && !state?.sites[i.platform]?.ready); }
function updateControls() {
  // Keep authorization locked until both execution and the final UI refresh finish.
  const busy = !!state?.busy || wasBusy || starting || creating || importing;
  $('approved').disabled = busy;
  for (const id of ['import', 'read-sheet', 'create', 'load', 'login-arc', 'login-aha', 'inspect']) $(id).disabled = busy;
  $('create').disabled = busy || state?.previewExclusionVersion !== 1 || state?.protectedExclusionVersion !== 1 || !preview || preview.rejected.length > 0 || !preview.accepted.some(i => !excludedEmails.has(i.email));
  for (const button of document.querySelectorAll('#preview-rows button')) button.disabled = busy || button.dataset.protected === 'true';
  $('file').disabled = busy;
  $('file-limit').textContent = `Excel .xlsx / CSV · Maximum ${state?.maxFileMb ?? 8} MB`;
  const gate = executionState(job, state, $('approved').checked);
  $('execute').disabled = busy || gate.disabled;
  $('execution-reason').textContent = gate.reason;
  $('stop').disabled = !state?.active || state.active.stopRequested;
  $('export').disabled = !job;
  $('reveal-result').disabled = !job || lastExportJob !== job.id || state?.revealResultVersion !== 1;
  $('sheet').disabled = busy;
  for (const button of document.querySelectorAll('#job-rows button')) button.disabled = busy || state?.deferredReviewVersion !== 1;
  $('defer-confirm').disabled = busy || !pendingDeferral || !$('defer-approved').checked || !$('defer-reason').value.trim();
  $('limit').disabled = busy;
  const pendingPlatforms = [...new Set((job?.items || []).filter(i => !done(i.status) && i.status !== 'DEFERRED').map(i => i.platform))];
  const maximum = Math.min(state?.maxBatch || 10, ...pendingPlatforms.map(p => state?.sites[p]?.maxBatch || 10));
  $('limit').max = maximum;
  if (Number($('limit').value) > maximum) $('limit').value = maximum;
  $('batch-note').textContent = `Up to ${maximum} platform actions per batch. Processing one teacher on ARC and AHA counts as two actions. Each batch requires renewed authorization.`;
  $('arc').disabled = busy; $('aha').disabled = busy;
  $('platform-note').textContent = state?.previewExclusionVersion !== 1 || state?.protectedExclusionVersion !== 1
    ? 'This server does not support roster exclusions. Quit the old app and restart start.command; refreshing the page is not enough.'
    : $('aha').checked
      ? state?.sites.aha.ready ? 'AHA is enabled. Both platforms use the same sign-in checks, inspection, authorization and results export workflow.' : 'AHA removal is not enabled. Inspection only.'
      : 'This job processes ARCLC only; it does not establish completion on both platforms.';
  $('protection-note').hidden = !(state?.protectedTeachers || []).length;
  $('protection-note').textContent = (state?.protectedTeachers || []).length
    ? 'Configured protection on both platforms: ' + state.protectedTeachers.map(t => t.fullName).join(', ') + '. Automatically excluded on each import by name or email; cannot be restored in preview. Removing protection requires separate authorization.'
    : '';
}
function renderPreview() {
  $('preview').hidden = !preview;
  if (!preview) return;
  $('source').textContent = `${preview.source.fileName} / ${preview.source.sheetName}`;
  $('counts').replaceChildren();
  for (const [value, label] of [[preview.sourceRowCount, 'Source rows'], [preview.accepted.length - excludedEmails.size, 'Included'], [excludedEmails.size, 'Excluded'], [preview.duplicateRows, 'Duplicates merged'], [preview.rejected.length, 'Need correction']]) {
    const box = document.createElement('div'); box.className = 'count'; const n = document.createElement('strong'); n.textContent = value; box.append(n, label); $('counts').append(box);
  }
  $('preview-rows').replaceChildren();
  const query = $('preview-search').value.trim().toLowerCase();
  let shown = 0;
  for (const item of [...preview.rejected, ...preview.accepted]) {
    const excluded = !item.reasons && excludedEmails.has(item.email);
    const protection = preview.protectedExclusions?.find(t => t.email === item.email);
    if (query && !`${item.fullName} ${item.email}`.toLowerCase().includes(query)) continue;
    if ($('excluded-only').checked && !excluded) continue;
    shown++;
    const tr = document.createElement('tr'); tr.classList.toggle('excluded-row', excluded);
    cell(tr, item.fullName); cell(tr, item.email); cell(tr, item.sourceRows.join(', ')); cell(tr, item.reasons?.join('; ') || (protection ? 'Protected - ' + protection.reason : excluded ? 'Excluded - skipped' : 'Valid - included'), item.reasons ? 'tag bad' : '');
    const td = document.createElement('td');
    if (item.reasons) td.textContent = 'Correct the source file';
    else {
      const button = document.createElement('button'); button.className = 'secondary roster-toggle';
      button.textContent = protection ? 'Protected - skipped' : excluded ? 'Include in Job' : 'Exclude from Job';
      button.dataset.protected = String(!!protection);
      button.setAttribute('aria-label', `${button.textContent}: ${item.fullName} (${item.email})`);
      button.addEventListener('click', () => {
        if (state?.busy || creating || importing || protection) return;
        if (excludedEmails.has(item.email)) excludedEmails.delete(item.email); else excludedEmails.add(item.email);
        renderPreview();
      });
      td.append(button);
    }
    tr.append(td); $('preview-rows').append(tr);
  }
  $('preview-summary').textContent = `Showing ${shown} rows. Included: ${preview.accepted.length - excludedEmails.size}; excluded: ${excludedEmails.size}. Search changes the display only, not the processing scope.` + (!shown ? ' No matching records.' : '');
  updateControls();
}
function renderJob() {
  if(pendingDeferral && pendingDeferral.id!==job?.id) {pendingDeferral=null;$('defer-panel').hidden=true;}
  $('job').hidden = !job;
  if (!job) return;
  $('job-title').textContent = job.source.fileName + ' / ' + job.source.sheetName;
  $('job-scope').textContent = job.scope + ' Job ID: ' + job.id;
  const completed = job.items.filter(i => done(i.status)).length;
  const deferred = job.items.filter(i => i.status === 'DEFERRED').length;
  const exclusions = job.excludedTeachers || [];
  $('job-counts').textContent = `${completed} / ${job.items.length} platform actions verified complete.` + (exclusions.length ? ` ${exclusions.length} teachers excluded during import and not queued.` : '') + (deferred ? ` ${deferred} items deferred for manual review; not counted as complete.` : '') + (lockedJob() ? ' Includes an unverified platform: inspection only.' : '');
  $('job-exclusions').hidden = !exclusions.length;
  $('job-excluded-rows').replaceChildren();
  for (const item of exclusions) {
    const tr = document.createElement('tr'); cell(tr, item.fullName + '\n' + item.email); cell(tr, item.sourceRows.join(', ')); cell(tr, item.detail); $('job-excluded-rows').append(tr);
  }
  $('job-rows').replaceChildren();
  for (const item of job.items) {
    const tr = document.createElement('tr'); cell(tr, item.fullName + '\n' + item.email); cell(tr, item.platform.toUpperCase() + ' / ' + (item.organization || item.organizationId));
    cell(tr, labels[item.status] || item.status, 'tag ' + (done(item.status) ? 'good' : ['PENDING','READY','RUNNING','CHECKING'].includes(item.status) ? '' : 'bad'));
    cell(tr, item.detail + (item.evidencePath ? '\nVerification evidence: ' + item.evidencePath : ''));
    const actionCell=document.createElement('td');
    if(canDefer(item.status)) {
      const button=document.createElement('button');button.className='secondary';button.textContent='Defer This Item';
      button.setAttribute('aria-label',`Defer This Item: ${item.fullName} / ${item.platform.toUpperCase()}`);
      button.addEventListener('click',()=>{
        if(state?.busy || importing || creating) return;
        pendingDeferral={...structuredClone(item),id:job.id};
        $('approved').checked=false;$('defer-approved').checked=false;$('defer-reason').value='';
        $('defer-target').textContent=`${item.fullName} · ${item.email} · ${item.platform.toUpperCase()} / ${item.organization||item.organizationId}. Current result: ${labels[item.status]||item.status}. ${item.detail}`;
        $('defer-panel').hidden=false;updateControls();$('defer-reason').focus();
      }); actionCell.append(button);
    } else actionCell.textContent=item.status==='DEFERRED'?'Deferred; not complete':'—';
    tr.append(actionCell);$('job-rows').append(tr);
  }
  updateControls();
}
async function historyList() {
  const items = await api('jobs'); const selected = job?.id || $('history').value;
  $('history').replaceChildren(new Option('Select a job', ''));
  for (const item of items) $('history').add(new Option(`${item.fileName} · ${item.completed}/${item.total} · ${new Date(item.updatedAt).toLocaleString('en-US')}`, item.id));
  $('history').value = selected;
}
async function readInput(sheetName) {
  if(importing) return;
  const file = $('file').files[0];
  if (!file) throw new Error('Select a roster file first.');
  if (file.size > (state?.maxFileBytes ?? 8 * 1024 * 1024)) throw new Error(`The file exceeds ${state?.maxFileMb ?? 8} MB.`);
  const generation=++importGeneration;
  importing=true;updateControls();
  const current=()=>generation===importGeneration && $('file').files[0]===file;
  try {
  preview = null; renderPreview(); $('sheet-picker').hidden = true;
  excludedEmails.clear(); $('preview-search').value = ''; $('excluded-only').checked = false;
  message('Reading the local roster. ARC/AHA will not be accessed...');
  const dataBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Unable to read the file')); reader.readAsDataURL(file); });
  if(!current()) return;
  const result = await api('import', { fileName: file.name, dataBase64, ...(sheetName === undefined ? {} : { sheetName }) });
  if(!current()) return;
  if (result.needsSheet) { $('sheet').replaceChildren(...result.sheetNames.map(name => new Option(name, name))); $('sheet-picker').hidden = false; message('Select the worksheet containing the roster.'); }
  else { preview = result; for (const item of result.protectedExclusions || []) excludedEmails.add(item.email); renderPreview(); message(result.rejected.length ? 'Invalid or conflicting records found. Correct the source file and import again.' : result.protectedExclusions?.length ? 'Roster loaded. Configured protected teachers were excluded. Review the preview before saving.' : 'Roster loaded. Manually exclude teachers who should not be processed, review the list, then save the job.', !!result.rejected.length); }
  } catch(error) {if(current()) throw error;}
  finally {if(generation===importGeneration) importing=false;updateControls();}
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    state = await api('state');
    $('storage').textContent = 'Local audit directory: ' + state.reportsDir;
    $('limit').max = state.maxBatch;
    $('login-state').textContent = state.browsers.length ? state.browsers.map(p => p.toUpperCase() + ': ' + ({READY:'Last check passed (rechecked before each action)', CHECKING:'Checking', LOGIN_REQUIRED:'Sign-in required', SESSION_UNVERIFIED:'Session unverified'}[state.loginStates?.[p]?.status] || 'Not checked')).join('; ') + '. After signing in, click Check Login again, then inspect unfinished items.' : 'Sign in through the automated browser. Opening a window does not verify your session.';
    $('progress').textContent = state.active ? `${state.active.mode === 'execute' ? 'Executing and verifying' : 'Read-only inspection'}: ${state.active.completed}/${state.active.total} · ${state.active.currentEmail}${state.active.stopRequested ? ' (will stop after the current teacher)' : ''}` : 'No operation is currently running.';
    if (job && (state.busy || wasBusy)) { job = await api('job?id=' + encodeURIComponent(job.id)); renderJob(); }
    if (wasBusy && !state.busy) {
      $('approved').checked = false; await historyList();
      message(state.lastError || 'This batch has ended. Review each result and authorize again before continuing.', !!state.lastError);
    }
    wasBusy = state.busy; updateControls();
  } catch (error) { message('Cannot connect to the local app: ' + error.message, true); $('execute').disabled = true; }
  finally { polling = false; }
}
function on(id, fn) { $(id).addEventListener('click', async () => { $(id).disabled = true; try { await fn(); } catch (error) { message(error.message, true); } finally { updateControls(); } }); }
on('import', () => readInput()); on('read-sheet', () => readInput($('sheet').value));
$('file').addEventListener('change', () => { importGeneration++;importing=false;preview = null; excludedEmails.clear(); $('sheet-picker').hidden = true; renderPreview(); updateControls(); });
$('preview-search').addEventListener('input', renderPreview);
$('excluded-only').addEventListener('change', renderPreview);
for (const id of ['arc','aha','approved']) $(id).addEventListener('change', updateControls);
on('create', async () => {
  if (state?.previewExclusionVersion !== 1 || state?.protectedExclusionVersion !== 1) throw new Error('Restart the app and import again. The old server cannot save protection or exclusion choices.');
  creating = true; updateControls();
  try {
  job = await api('create', { previewId: preview.previewId, excludedEmails: [...excludedEmails], platforms: [$('arc').checked ? 'arclc' : null, $('aha').checked ? 'aha' : null].filter(Boolean) });
  preview = null; renderPreview(); $('approved').checked = false; renderJob(); await historyList(); message('Job saved locally. Sign in and verify the scope before executing.');
  } finally { creating = false; }
});
for (const [id, platform] of [['login-arc','arclc'], ['login-aha','aha']]) on(id, async () => { message('Opening the automated browser. Complete sign-in there.'); await api('login', { platform }); await refresh(); });
on('load', async () => { if (!$('history').value) throw new Error('Select a job.'); job = await api('job?id=' + encodeURIComponent($('history').value)); $('approved').checked = false; renderJob(); message('Local progress loaded. Inspect uncertain items before retrying.'); });
for (const [id, mode] of [['inspect','inspect'], ['execute','execute']]) on(id, async () => {
  if (starting || wasBusy || state?.busy) throw new Error('Wait for the current operation and result refresh to finish.');
  if (!job) throw new Error('Save or open a local job first.');
  const confirmation = mode === 'execute' && $('approved').checked ? 'UNALIGN:' + job.id : undefined;
  starting = true; $('approved').checked = false; updateControls();
  try {
    await api('start', { id: job.id, mode, limit: Number($('limit').value), confirmation });
    wasBusy = true; message(mode === 'execute' ? 'Live removal has started. Do not interact with or close the automated browser.' : 'Inspection started. No removal will be submitted.'); await refresh();
  } finally { starting = false; updateControls(); }
});
on('stop', async () => { await api('stop', {}); await refresh(); });
on('export', async () => { const id=job.id;const result = await api('export', { id });lastExportJob=id; message('Results CSV saved locally: \n' + result.filePath+'\nClick Show in Finder to locate the file.'); });
on('reveal-result',async()=>{await api('reveal-result',{id:job.id});message('Requested Finder to reveal the exported file.');});
on('defer-cancel',async()=>{pendingDeferral=null;$('defer-panel').hidden=true;});
$('defer-approved').addEventListener('change',updateControls);
$('defer-reason').addEventListener('input',updateControls);
on('defer-confirm',async()=>{
  const item=pendingDeferral;
  if(!item || job?.id!==item.id || !$('defer-approved').checked) throw new Error('Select the item to defer again and confirm.');
  creating=true;updateControls();
  try {
    job=await api('defer',{id:item.id,email:item.email,platform:item.platform,expectedStatus:item.status,expectedDetail:item.detail,
      expectedCheckedAt:item.checkedAt||'',reason:$('defer-reason').value,confirmation:`DEFER:${item.id}:${item.platform}:${item.email}`});
    pendingDeferral=null;$('defer-panel').hidden=true;$('approved').checked=false;
    renderJob();await historyList();message('This platform action was deferred and is not counted as complete. Review the remaining roster, then authorize the next batch.');
  } finally {creating=false;}
});
await refresh(); await historyList().catch(error => message(error.message, true)); setInterval(refresh, 1500);
