import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJob, LocalCoordinator, JobStore, jobCsv, validateJob } from '../src/local/jobs.mjs';
import { normalizeRoster } from '../src/local/import.mjs';

const decisionFor=(job,item,reason='Leave for manual review')=>({email:item.email,platform:item.platform,expectedStatus:item.status,
  expectedDetail:item.detail,expectedCheckedAt:item.checkedAt||'',reason,confirmation:`DEFER:${job.id}:${item.platform}:${item.email}`});

test('shutdown waits until an approved deferral is saved',async()=>{
  const f=await fixture();f.job.items[0].status='MANUAL_REVIEW';await f.coordinator.store.save(f.job);
  const save=f.coordinator.store.save.bind(f.coordinator.store);
  let release,entered;const enteredSave=new Promise(resolve=>entered=resolve);const gate=new Promise(resolve=>release=resolve);
  f.coordinator.store.save=async job=>{entered();await gate;return save(job);};
  const decision=f.coordinator.defer(f.job.id,decisionFor(f.job,f.job.items[0]));await enteredSave;
  let closed=false;const closing=f.coordinator.close().then(()=>closed=true);await Promise.resolve();
  assert.equal(closed,false);release();await decision;await closing;
  assert.equal((await f.coordinator.store.load(f.job.id)).items[0].status,'DEFERRED');assert.equal(closed,true);
});

test('operator deferral is durable, task-and-platform scoped, never complete, and allows other teachers to continue',async()=>{
  const f=await fixture();f.job.items[0].status='MANUAL_REVIEW';f.job.items[0].detail='Only administrator';
  await f.coordinator.store.save(f.job);
  const item=f.job.items[0];await f.coordinator.defer(f.job.id,decisionFor(f.job,item));
  await f.coordinator.start(f.job.id,'execute',10,'UNALIGN:'+f.job.id);await f.coordinator.running;
  const saved=await f.coordinator.getJob(f.job.id);
  assert.deepEqual(saved.items.map(i=>i.status),['DEFERRED','REMOVED','REMOVED']);
  assert.equal(saved.items[0].deferredFrom.status,'MANUAL_REVIEW');assert.equal(f.counts().actions,2);
  assert.equal((await f.coordinator.store.list())[0].completed,2);
  assert.match(jobCsv(saved),/DEFERRED/);
  assert.equal(createJob(f.roster,['arclc','aha'],f.config).items.filter(i=>i.email===item.email).length,2);
  const audit=(await readFile(path.join(f.config.runtime.reportsDir,'audit/events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit[0].action,'DEFER_FOR_MANUAL_REVIEW');assert.equal(audit[0].previousStatus,'MANUAL_REVIEW');
  const both=createJob(f.roster,['arclc','aha'],f.config);both.items[0].status='UNVERIFIED';
  await f.coordinator.store.save(both);await f.coordinator.defer(both.id,decisionFor(both,both.items[0]));
  assert.equal((await f.coordinator.getJob(both.id)).items.find(i=>i.platform==='aha'&&i.email===item.email).status,'PENDING');
});

test('deferral rejects stale results, changed platform, absent confirmation, success, invalid reason and concurrent operations',async()=>{
  const f=await fixture();const item=f.job.items[0];item.status='MANUAL_REVIEW';item.checkedAt='2026-09-18T00:00:00Z';await f.coordinator.store.save(f.job);
  const decision=decisionFor(f.job,item);
  for(const change of [{expectedStatus:'ERROR'},{expectedDetail:'Changed'},{expectedCheckedAt:''},{platform:'aha'},{confirmation:''},{reason:''},{reason:'a'.repeat(501)}]) {
    await assert.rejects(f.coordinator.defer(f.job.id,{...decision,...change}));
  }
  f.coordinator.busy=true;await assert.rejects(f.coordinator.defer(f.job.id,decision),/running/);f.coordinator.busy=false;
  await f.coordinator.defer(f.job.id,decision);await assert.rejects(f.coordinator.defer(f.job.id,decision),/Only unresolved/);
  assert.equal(f.counts().actions,0);
  item.status='REMOVED';await f.coordinator.store.save(f.job);await assert.rejects(f.coordinator.defer(f.job.id,decisionFor(f.job,item)),/Only unresolved/);
});

test('deferral audit failure leaves the task unchanged',async()=>{
  const f=await fixture();f.job.items[0].status='MANUAL_REVIEW';await f.coordinator.store.save(f.job);
  await writeFile(f.config.runtime.reportsDir,'not a directory');
  await assert.rejects(f.coordinator.defer(f.job.id,decisionFor(f.job,f.job.items[0])));
  assert.equal((await f.coordinator.getJob(f.job.id)).items[0].status,'MANUAL_REVIEW');assert.equal(f.coordinator.busy,false);
});

test('AHA view evidence survives read-only inspection, execution, reopening and CSV export',async()=>{
  const f=await fixture();Object.assign(f.config.sites.aha,{implementationStatus:'ready',coverageVerified:true});
  const job=createJob(f.roster,['aha'],f.config);await f.coordinator.store.save(job);await f.coordinator.login('aha');
  const evidence=['ALL','ACTIVE','EXPIRED'].map(filter=>({filter,status:'ABSENT_IN_VIEW',checkedAt:'2026-09-18T00:00:00Z'}));
  f.coordinator.adapterFactory=()=>({inspect:async()=>({status:'ABSENT_VERIFIED',detail:'checked',evidence}),unalign:async()=>({status:'ABSENT_VERIFIED',detail:'checked',evidence})});
  await f.coordinator.start(job.id,'inspect',1);await f.coordinator.running;
  await f.coordinator.start(job.id,'execute',1,'UNALIGN:'+job.id);await f.coordinator.running;
  const saved=await f.coordinator.getJob(job.id);
  for(const item of saved.items.slice(0,2)) {
    assert.deepEqual(item.evidence,evidence);
    assert.deepEqual(JSON.parse(await readFile(item.evidencePath,'utf8')).views,evidence);
    assert.ok(jobCsv(saved).includes(item.evidencePath));
  }
  const audit=(await readFile(path.join(f.config.runtime.reportsDir,'audit/events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.at(-1).evidence,evidence);
});

test('failed evidence persistence stops the batch without a completed status or stale evidence',async()=>{
  const f=await fixture();Object.assign(f.config.sites.aha,{implementationStatus:'ready',coverageVerified:true});
  const job=createJob(f.roster,['aha'],f.config);
  job.items[0].evidence=[{filter:'ALL',status:'OLD'}];job.items[0].evidencePath='/old/evidence.json';
  await f.coordinator.store.save(job);await f.coordinator.login('aha');
  const {mkdir}=await import('node:fs/promises');await mkdir(f.config.runtime.reportsDir,{recursive:true});
  await writeFile(path.join(f.config.runtime.reportsDir,'verification'),'blocks evidence directory');
  let actions=0;f.coordinator.adapterFactory=()=>({unalign:async()=>{actions++;return {status:'REMOVED',detail:'Synthetic result',evidence:[{filter:'ALL',status:'ABSENT_IN_VIEW'}]};}});
  await f.coordinator.start(job.id,'execute',3,'UNALIGN:'+job.id);await f.coordinator.running;
  const saved=await f.coordinator.getJob(job.id);
  assert.equal(actions,1);assert.equal(saved.items[0].status,'INTERRUPTED');assert.equal(saved.items[1].status,'PENDING');
  assert.equal(saved.items[0].evidencePath,undefined);assert.equal(saved.items[0].evidence,undefined);
  assert.equal(saved.items[0].previousEvidencePath,'/old/evidence.json');
  assert.equal((await f.coordinator.store.list())[0].completed,0);
});

test('100-action mixed batch remains serial, checks each session, then requires renewed approval',async()=>{
  const f=await fixture();f.config.safety.maxExecuteActions=100;
  Object.assign(f.config.sites.aha,{implementationStatus:'ready',coverageVerified:true,maxBatchActions:100});
  const roster={...f.roster,accepted:Array.from({length:51},(_,n)=>({fullName:'Synthetic '+n,email:`person${n}@example.com`,sourceRows:[n+2],achievements:[]}))};
  const job=createJob(roster,['arclc','aha'],f.config);await f.coordinator.store.save(job);await f.coordinator.login('aha');
  const seen=[];let checks=0,active=0,peak=0;
  f.coordinator.sessionChecker=async()=>{checks++;return {status:'READY',detail:'synthetic login check'};};
  f.coordinator.adapterFactory=platform=>({unalign:async item=>{
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));
    seen.push(platform+':'+item.email);active--;return {status:'REMOVED',detail:'synthetic verified removal'};
  }});
  await assert.rejects(f.coordinator.start(job.id,'execute',101,'UNALIGN:'+job.id),/1–100/);
  await f.coordinator.start(job.id,'execute',100,'UNALIGN:'+job.id);await f.coordinator.running;
  assert.equal(seen.length,100);assert.equal(checks,100);assert.equal(peak,1);
  await assert.rejects(f.coordinator.start(job.id,'execute',100,''),/not been authorized/);
  await f.coordinator.start(job.id,'execute',100,'UNALIGN:'+job.id);await f.coordinator.running;
  assert.equal(seen.length,102);assert.equal(new Set(seen).size,102);assert.equal(checks,102);
  assert.ok((await f.coordinator.getJob(job.id)).items.every(i=>i.status==='REMOVED'));
});

test('100-action cap still stops at a session expiry or uncertain result without touching the next teacher',async()=>{
  for(const reason of ['expired','unverified']) {
    const f=await fixture();f.config.safety.maxExecuteActions=100;
    let checks=0,actions=0;
    f.coordinator.sessionChecker=async()=>({status:++checks===2&&reason==='expired'?'LOGIN_REQUIRED':'READY',detail:'synthetic'});
    f.coordinator.adapterFactory=()=>({unalign:async()=>({status:++actions===2&&reason==='unverified'?'UNVERIFIED':'REMOVED',detail:'synthetic'})});
    await f.coordinator.start(f.job.id,'execute',100,'UNALIGN:'+f.job.id);await f.coordinator.running;
    const saved=await f.coordinator.getJob(f.job.id);
    assert.deepEqual(saved.items.map(i=>i.status),['REMOVED',reason==='expired'?'LOGIN_REQUIRED':'UNVERIFIED','PENDING']);
    assert.equal(actions,reason==='expired'?1:2);
  }
});

test('AHA ten-action batch stops at ten; continuation requires confirmation and never repeats verified items', async () => {
  const f = await fixture();
  Object.assign(f.config.sites.aha, {implementationStatus:'ready',coverageVerified:true,maxBatchActions:10});
  const roster = {...f.roster,accepted:Array.from({length:12},(_,n)=>({fullName:'Synthetic '+n,email:`synthetic${n}@example.com`,sourceRows:[n+2],achievements:[]}))};
  const job = createJob(roster,['aha'],f.config);
  await f.coordinator.store.save(job);
  await f.coordinator.login('aha');
  const seen = [];
  f.coordinator.adapterFactory = () => ({unalign:async item=>{seen.push(item.email);return {status:'ABSENT_VERIFIED',detail:'synthetic verified absence'};}});
  await assert.rejects(f.coordinator.start(job.id,'execute',11,'UNALIGN:'+job.id), /1–10/);
  await f.coordinator.start(job.id,'execute',10,'UNALIGN:'+job.id); await f.coordinator.running;
  assert.equal(seen.length,10);
  let saved = await f.coordinator.getJob(job.id);
  assert.equal(saved.items.filter(i=>i.status==='ABSENT_VERIFIED').length,10);
  assert.equal(saved.items.filter(i=>i.status==='PENDING').length,2);
  await assert.rejects(f.coordinator.start(job.id,'execute',10,''), /not been authorized/);
  await f.coordinator.start(job.id,'execute',10,'UNALIGN:'+job.id); await f.coordinator.running;
  assert.equal(seen.length,12);
  assert.equal(new Set(seen).size,12);
  saved = await f.coordinator.getJob(job.id);
  assert.ok(saved.items.every(i=>i.status==='ABSENT_VERIFIED'));
});

test('AHA ten-action allowance still stops immediately on an uncertain result', async () => {
  const f = await fixture(['UNVERIFIED']);
  Object.assign(f.config.sites.aha, {implementationStatus:'ready',coverageVerified:true,maxBatchActions:10});
  const job = createJob(f.roster,['aha'],f.config);
  await f.coordinator.store.save(job); await f.coordinator.login('aha');
  await f.coordinator.start(job.id,'execute',10,'UNALIGN:'+job.id); await f.coordinator.running;
  assert.equal(f.counts().actions,1);
  assert.deepEqual((await f.coordinator.getJob(job.id)).items.map(i=>i.status),['UNVERIFIED','PENDING','PENDING']);
  await assert.rejects(f.coordinator.start(job.id,'execute',10,'UNALIGN:'+job.id), /Inspect unfinished/);
});

test('protected identities are excluded server-side on every import; pending legacy jobs cannot bypass protection', async () => {
  const f = await fixture();
  f.config.safety.protectedTeachers = [{...f.roster.accepted[0], reason:'Keep affiliation'}];
  const job = createJob(f.roster, ['arclc','aha'], f.config, []);
  assert.equal(job.items.length, 4);
  assert.equal(job.excludedTeachers[0].protected, true);
  assert.ok(job.items.every(i => i.email !== f.roster.accepted[0].email));
  await f.coordinator.store.save(job);
  assert.equal((await f.coordinator.getJob(job.id)).excludedTeachers[0].protected, true);
  await assert.rejects(f.coordinator.start(f.job.id, 'execute', 1, 'UNALIGN:'+f.job.id), /Protected teacher/);
  await assert.rejects(f.coordinator.start(f.job.id, 'inspect', 1), /Protected teacher/);
  assert.equal(f.counts().actions, 0);
  assert.equal(createJob(f.roster, ['arclc'], f.config).excludedTeachers.length, 1);
  assert.equal((await f.coordinator.getJob(f.job.id)).items[0].status, 'PENDING', 'historic job is not rewritten');
});

test('both platforms use the same login, fresh session checks, approval and audited execution with AHA batch cap', async () => {
  const f = await fixture();
  Object.assign(f.config.sites.aha, {implementationStatus:'ready',coverageVerified:true,maxBatchActions:3});
  const job = createJob(f.roster, ['arclc','aha'], f.config);
  await f.coordinator.store.save(job);
  const checked = [], mutated = [];
  f.coordinator.sessionChecker = async platform => { checked.push(platform); return {status:'READY',detail:'synthetic fresh login'}; };
  f.coordinator.adapterFactory = platform => ({unalign:async item => {mutated.push([platform,item.email]);return {status:'REMOVED',detail:'synthetic verified'};}});
  await f.coordinator.login('arclc'); await f.coordinator.login('aha');
  assert.deepEqual(checked, ['arclc','aha']);
  await assert.rejects(f.coordinator.start(job.id,'execute',4,'UNALIGN:'+job.id), /up to 3/);
  await assert.rejects(f.coordinator.start(job.id,'execute',3,''), /not been authorized/);
  await f.coordinator.start(job.id,'execute',3,'UNALIGN:'+job.id); await f.coordinator.running;
  assert.equal(mutated.length,3);
  await f.coordinator.start(job.id,'execute',3,'UNALIGN:'+job.id); await f.coordinator.running;
  assert.deepEqual(mutated.map(i=>i[0]), ['arclc','arclc','arclc','aha','aha','aha']);
  assert.deepEqual(checked, ['arclc','aha',...mutated.map(i=>i[0])]);
  const audit = await readFile(path.join(f.config.runtime.reportsDir,'audit/events.jsonl'),'utf8');
  assert.equal(audit.trim().split('\n').length,12);
});

async function fixture(statuses = ['REMOVED','REMOVED','REMOVED']) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'offboarding-local-'));
  const config = {runtime:{baseDir,reportsDir:path.join(baseDir,'reports')},safety:{maxExecuteActions:10},sites:{arclc:{enabled:true,implementationStatus:'ready',organizationLabel:'ALLCPR Inc.'},aha:{enabled:true,implementationStatus:'discovery_complete',organizationId:'32238',coverageVerified:false}}};
  let actions = 0, checks = 0;
  const coordinator = new LocalCoordinator(config, { sessionChecker: async () => ({status:'READY', detail:'synthetic login check'}), openSession: async () => ({page:{isClosed:()=>false,goto:async()=>{}}, context:{close:async()=>{}}}), adapterFactory: () => ({unalign:async()=>({status:statuses[actions++],detail:'mock outcome'}), inspect:async()=>{checks++; return {status:'READY',detail:'fresh mock read'};}}) });
  const roster = {source:{fileName:'synthetic.csv',sheetName:'CSV',sha256:'test'},rejected:[],accepted:[1,2,3].map(n=>({fullName:'Teacher '+n,email:`teacher${n}@example.com`,sourceRows:[n+1],achievements:[]}))};
  const job=createJob(roster,['arclc'],config); await coordinator.store.save(job); await coordinator.login('arclc');
  return {coordinator,config,job,roster,counts:()=>({actions,checks})};
}

test('local jobs need no Sheet credentials; verified results are skipped on same-job continuation', async () => {
  const f=await fixture();
  await f.coordinator.start(f.job.id,'execute',1,'UNALIGN:'+f.job.id); await f.coordinator.running;
  await f.coordinator.start(f.job.id,'execute',3,'UNALIGN:'+f.job.id); await f.coordinator.running;
  assert.equal(f.counts().actions,3);
  const final=await f.coordinator.getJob(f.job.id); assert.ok(final.items.every(i=>i.status==='REMOVED'));
  const audit=await readFile(path.join(f.config.runtime.reportsDir,'audit/events.jsonl'),'utf8');
  assert.equal(audit.trim().split('\n').length,6);
  assert.equal((await f.coordinator.store.list())[0].completed,3);
});

test('session expiry between teachers stops before mutation; re-login alone does not resume the batch', async () => {
  const f = await fixture();
  let checks = 0;
  f.coordinator.sessionChecker = async () => ({ status: ++checks === 2 ? 'LOGIN_REQUIRED' : 'READY', detail: 'synthetic session state' });
  await f.coordinator.start(f.job.id, 'execute', 3, 'UNALIGN:' + f.job.id);
  await f.coordinator.running;
  assert.equal(f.counts().actions, 1);
  assert.deepEqual((await f.coordinator.getJob(f.job.id)).items.map(i => i.status), ['REMOVED','LOGIN_REQUIRED','PENDING']);
  await f.coordinator.login('arclc');
  assert.equal(f.counts().actions, 1);
  await assert.rejects(f.coordinator.start(f.job.id, 'execute', 3, 'UNALIGN:' + f.job.id), /Inspect unfinished/);
  await f.coordinator.start(f.job.id, 'inspect', 3);
  await f.coordinator.running;
  assert.equal(f.counts().actions, 1);
  await f.coordinator.start(f.job.id, 'execute', 3, 'UNALIGN:' + f.job.id);
  await f.coordinator.running;
  assert.equal(f.counts().actions, 3);
});

test('uncertain result stops; retry requires fresh inspection and explicit confirmation', async () => {
  const f=await fixture(['UNVERIFIED','REMOVED','REMOVED','REMOVED']);
  await f.coordinator.start(f.job.id,'execute',3,'UNALIGN:'+f.job.id); await f.coordinator.running;
  assert.equal(f.counts().actions,1);
  await assert.rejects(f.coordinator.start(f.job.id,'execute',3,'UNALIGN:'+f.job.id),/Inspect unfinished/);
  await f.coordinator.start(f.job.id,'inspect',3); await f.coordinator.running;
  assert.equal(f.counts().checks,3); assert.equal(f.counts().actions,1);
  await assert.rejects(f.coordinator.start(f.job.id,'execute',3,'wrong'),/not been authorized/);
  await f.coordinator.start(f.job.id,'execute',3,'UNALIGN:'+f.job.id); await f.coordinator.running;
  assert.equal(f.counts().actions,4);
});

test('interrupted manifests become unknown, AHA is locked, scope tampering and duplicate identities are rejected', async () => {
  const f=await fixture();
  f.job.items[0].status='RUNNING'; await f.coordinator.store.save(f.job);
  assert.equal((await f.coordinator.getJob(f.job.id)).items[0].status,'INTERRUPTED');
  const aha=createJob(f.roster,['aha'],f.config); await f.coordinator.store.save(aha);
  await assert.rejects(f.coordinator.start(aha.id,'execute',3,'UNALIGN:'+aha.id),/not passed acceptance/);
  f.job.items[0].status='PENDING'; f.job.items[0].organization='Other'; await f.coordinator.store.save(f.job);
  await assert.rejects(f.coordinator.start(f.job.id,'execute',3,'UNALIGN:'+f.job.id),/scope/);
  await assert.rejects(f.coordinator.store.load('../../config'),/job ID/);
  assert.equal(f.counts().actions,0);
  assert.throws(()=>createJob({...f.roster,rejected:[{}]},['arclc'],f.config),/invalid/);
});

test('CSV export escapes formulas and concurrent starts are refused', async () => {
  const f=await fixture(); f.job.items[0].fullName='=1+1';
  assert.ok(jobCsv(f.job).includes('"\'=1+1"'));
  f.coordinator.busy=true;
  await assert.rejects(f.coordinator.start(f.job.id,'execute',1,'UNALIGN:'+f.job.id),/another cannot be started/);
  await assert.rejects(f.coordinator.login('arclc'),/already running/);
});

test('stop waits for current verification and never starts the next teacher', async () => {
  const f=await fixture();
  let release, started;
  const firstStarted=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  let calls=0;
  f.coordinator.adapterFactory=()=>({unalign:async()=>{calls++;started();await gate;return {status:'REMOVED',detail:'verified'};}});
  await f.coordinator.start(f.job.id,'execute',3,'UNALIGN:'+f.job.id);
  await firstStarted; f.coordinator.stop();
  await assert.rejects(f.coordinator.start(f.job.id,'execute',1,'UNALIGN:'+f.job.id),/another cannot be started/);
  release(); await f.coordinator.running;
  const job=await f.coordinator.getJob(f.job.id);
  assert.equal(calls,1); assert.deepEqual(job.items.map(i=>i.status),['REMOVED','PENDING','PENDING']);
});

test('unwritable local audit prevents website mutation and requires recovery inspection', async () => {
  const f=await fixture();
  await writeFile(f.config.runtime.reportsDir,'not a directory');
  await f.coordinator.start(f.job.id,'execute',3,'UNALIGN:'+f.job.id); await f.coordinator.running;
  assert.equal(f.counts().actions,0);
  assert.equal((await f.coordinator.getJob(f.job.id)).items[0].status,'INTERRUPTED');
});

test('explicit task-scoped deferral preserves manual item and allows the next two teachers only', async () => {
  const f=await fixture();
  f.job.items[0].status='MANUAL_REVIEW'; f.job.items[0].detail='Only protected roles';
  await f.coordinator.store.save(f.job);
  f.config.localManualReviewDeferrals=[{jobId:f.job.id,email:f.job.items[0].email,platform:'arclc',expectedDetail:'Only protected roles',reason:'Operator approved manual handling'}];
  await f.coordinator.applyConfiguredDeferrals();
  await f.coordinator.applyConfiguredDeferrals();
  assert.equal((await f.coordinator.getJob(f.job.id)).items[0].status,'DEFERRED');
  await f.coordinator.start(f.job.id,'execute',3,'UNALIGN:'+f.job.id); await f.coordinator.running;
  assert.equal(f.counts().actions,2);
  const final=await f.coordinator.getJob(f.job.id);
  assert.deepEqual(final.items.map(i=>i.status),['DEFERRED','REMOVED','REMOVED']);
  assert.equal((await f.coordinator.store.list())[0].completed,2);
  const audit=await readFile(path.join(f.config.runtime.reportsDir,'audit/events.jsonl'),'utf8');
  assert.equal(audit.split('\n').filter(line=>line.includes('DEFER_FOR_MANUAL_REVIEW')).length,1);
  const newJob=createJob(f.roster,['arclc'],f.config); await f.coordinator.store.save(newJob);
  await f.coordinator.applyConfiguredDeferrals();
  assert.equal((await f.coordinator.getJob(newJob.id)).items[0].status,'PENDING');
});

test('deferral cannot override a changed reason, status or platform', async () => {
  const f=await fixture();
  f.job.items[0].status='MANUAL_REVIEW'; f.job.items[0].detail='Unexpected error'; await f.coordinator.store.save(f.job);
  f.config.localManualReviewDeferrals=[{jobId:f.job.id,email:f.job.items[0].email,platform:'arclc',expectedDetail:'Only protected roles',reason:'Operator approved'}];
  await f.coordinator.applyConfiguredDeferrals();
  assert.equal((await f.coordinator.getJob(f.job.id)).items[0].status,'MANUAL_REVIEW');
  await assert.rejects(f.coordinator.start(f.job.id,'execute',3,'UNALIGN:'+f.job.id),/Inspect unfinished/);
  assert.equal(f.counts().actions,0);
});

test('preview exclusions survive save/reload, skip both inspection and execution, and remain distinct in exports', async () => {
  const f = await fixture();
  const roster = { source: f.roster.source, ...normalizeRoster([
    ['Full Name', 'Email'], ['Keep Admin', 'KEEP@example.com'], ['Keep Admin', 'keep@example.com'],
    ['Departed Teacher', 'departed@example.com'], ['Same Name', 'other@example.com']
  ]) };
  const snapshot = structuredClone(roster);
  const job = createJob(roster, ['arclc'], f.config, ['keep@example.com']);
  assert.deepEqual(roster, snapshot, 'source roster is immutable');
  assert.deepEqual(job.excludedTeachers[0].sourceRows, [2, 3]);
  assert.deepEqual(job.items.map(i => i.email), ['departed@example.com', 'other@example.com']);
  assert.equal(job.excludedTeachers[0].status, 'EXCLUDED');
  assert.ok(job.excludedTeachers[0].excludedAt);
  await f.coordinator.store.save(job);
  const seen = [], inspected = [];
  f.coordinator.adapterFactory = () => ({
    inspect: async item => { inspected.push(item.email); return {status: 'READY', detail: 'mock'}; },
    unalign: async item => { seen.push(item.email); return {status: 'REMOVED', detail: 'mock'}; }
  });
  await f.coordinator.start(job.id, 'inspect', 10); await f.coordinator.running;
  await f.coordinator.start(job.id, 'execute', 1, 'UNALIGN:' + job.id); await f.coordinator.running;
  await f.coordinator.start(job.id, 'execute', 10, 'UNALIGN:' + job.id); await f.coordinator.running;
  assert.deepEqual(inspected, ['departed@example.com', 'other@example.com']);
  assert.deepEqual(seen, inspected);
  const saved = await new JobStore(f.coordinator.store.directory).load(job.id);
  assert.deepEqual(saved.excludedTeachers, job.excludedTeachers);
  const listing = (await f.coordinator.store.list()).find(j => j.id === job.id);
  assert.equal(listing.completed, 2); assert.equal(listing.total, 2);
  const csv = jobCsv(saved);
  assert.match(csv, /"keep@example.com","arclc","ALLCPR Inc.","2,3","EXCLUDED"/);
  const audit = await readFile(path.join(f.config.runtime.reportsDir, 'audit/events.jsonl'), 'utf8');
  assert.ok(!audit.includes('keep@example.com'), 'excluded teachers never produce a website action audit');
  const restored = createJob(roster, ['arclc'], f.config, []);
  assert.equal(restored.items.length, 3, 'exclusions do not become a permanent skip list');
});

test('preview exclusion identities are exact, server-validated and apply across all selected platforms', async () => {
  const f = await fixture();
  const excluded = f.roster.accepted[0].email;
  for (const invalid of [null, 'teacher1@example.com', ['unknown@example.com'], [excluded, excluded], [excluded.toUpperCase()], [{}]]) {
    assert.throws(() => createJob(f.roster, ['arclc'], f.config, invalid), /Invalid exclusions/);
  }
  assert.throws(() => createJob(f.roster, ['arclc'], f.config, f.roster.accepted.map(i => i.email)), /All teachers are excluded/);
  assert.throws(() => createJob({...f.roster, rejected: [{}]}, ['arclc'], f.config, [excluded]), /invalid records/);
  const both = createJob(f.roster, ['arclc', 'aha'], f.config, [excluded]);
  assert.equal(both.items.length, 4);
  assert.ok(both.items.every(i => i.email !== excluded));
  assert.deepEqual(both.excludedTeachers[0].platforms, ['arclc', 'aha']);
  assert.equal(jobCsv(both).split('\r\n').filter(l => l.includes('"EXCLUDED"')).length, 2);
  validateJob(both, f.config);
  both.items.push({...createJob(f.roster, ['arclc'], f.config).items[0]});
  assert.throws(() => validateJob(both, f.config), /scope/, 'a queued excluded identity fails closed');
});
