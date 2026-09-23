import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { teacherProtection, protectedExclusions, batchLimit } from '../src/protection.mjs';
import { AhaAdapter } from '../src/platforms/aha.mjs';
import { ArclcAdapter } from '../src/platforms/arclc.mjs';
import { executionState } from '../ui/execution-state.js';
import { createJob } from '../src/local/jobs.mjs';

const config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
const protectedFixture = { ...config, safety: { ...config.safety, protectedTeachers: Array.from({length:4}, (_,i)=>({fullName:'Synthetic Protected '+i,email:`protected${i}@example.com`,reason:'Synthetic opt-in only'})) } };

test('optional protection configuration uses synthetic fixtures, not installed permanent identities', async () => {
  for (const item of protectedFixture.safety.protectedTeachers) {
    assert.ok(teacherProtection({...item, fullName:'Different Name'}, protectedFixture));
    assert.ok(teacherProtection({email:'changed@example.com',fullName:' '+item.fullName.toUpperCase()+' '}, protectedFixture));
    for (const Adapter of [AhaAdapter, ArclcAdapter]) {
      // No page: protection must run before any browser method or readiness check.
      await assert.rejects(new Adapter(protectedFixture, null).unalign(item), /Protected teacher cannot be unaligned/);
    }
  }
  assert.equal(teacherProtection({fullName:'Other Teacher',email:'other@example.com'}, protectedFixture), undefined);
  assert.equal(protectedExclusions({accepted:protectedFixture.safety.protectedTeachers}, protectedFixture).length, 4);
});

test('installed configuration has no permanent teacher exclusions; manual choices apply to one task and both platforms only', async () => {
  assert.deepEqual(config.safety.protectedTeachers || [], []);
  assert.deepEqual(config.localManualReviewDeferrals || [], []);
  const historical = {source:{fileName:'synthetic.csv',sheetName:'CSV'},excludedTeachers:Array.from({length:4},(_,n)=>({fullName:'Synthetic Teacher '+n,email:`excluded${n}@example.com`,sourceRows:[n+2]}))};
  const snapshot = structuredClone(historical);
  const roster = {source:historical.source,rejected:[],accepted:historical.excludedTeachers.map(t=>({fullName:t.fullName,email:t.email,sourceRows:t.sourceRows,achievements:[]}))};
  assert.equal(roster.accepted.length,4);
  assert.deepEqual(protectedExclusions(roster,config),[]);
  const fresh = createJob(roster,['arclc','aha'],config);
  assert.equal(fresh.items.length,8);
  assert.equal(fresh.excludedTeachers.length,0);
  const manual = createJob(roster,['arclc','aha'],config,[roster.accepted[0].email]);
  assert.equal(manual.items.length,6);
  assert.equal(manual.excludedTeachers.length,1);
  assert.equal(manual.excludedTeachers[0].protected,false);
  assert.equal(createJob(roster,['arclc','aha'],config).items.length,8,'next import does not inherit previous exclusions');
  assert.deepEqual(historical,snapshot,'historic decisions remain intact');
});

test('distributed configuration defaults to read-only while offering dual-platform caps of 100', async () => {
  assert.equal(config.sites.aha.implementationStatus, 'discovery_complete');
  assert.equal(config.sites.aha.coverageVerified, false);
  assert.equal(config.sites.arclc.implementationStatus, 'discovery_complete');
  assert.deepEqual(config.sites.arclc.allowedConfirmMessages, []);
  assert.equal(batchLimit(config,['aha']), 100);
  assert.equal(batchLimit(config,['arclc','aha']), 100);
  assert.equal(batchLimit(config,['arclc']), 100);
});

test('configured platform caps remain respected and invalid batch caps fail closed',()=>{
  const lower=structuredClone(config);lower.sites.aha.maxBatchActions=3;
  assert.equal(batchLimit(lower,['arclc','aha']),3);
  assert.equal(batchLimit(lower,['arclc']),100);
  for(const value of [0,-1,101,1.5,'100',null]) {
    assert.throws(()=>batchLimit({...config,safety:{maxExecuteActions:value}},[]),/1 to 100/);
  }
});

test('old pending jobs containing a protected teacher are visibly blocked; historic completed results remain unchanged', () => {
  const item = {...protectedFixture.safety.protectedTeachers[3], platform:'arclc', status:'READY'};
  const job = {items:[item]};
  const state = {busy:false,sites:{arclc:{ready:true}},browsers:['arclc'],protectedTeachers:protectedFixture.safety.protectedTeachers};
  assert.match(executionState(job, state, true).reason, /protected/);
  item.status = 'REMOVED';
  assert.match(executionState(job, state, true).reason, /verified complete/);
  assert.equal(item.status, 'REMOVED');
});
