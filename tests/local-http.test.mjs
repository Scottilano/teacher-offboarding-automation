import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startLocalServer } from '../src/local/server.mjs';
import {largeRoster} from './large-roster-fixture.mjs';

test('HTTP imports a 10 MB synthetic roster past the former request cap and advertises configured limits',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'offboarding-large-http-'));
  const config={import:{maxFileMb:50},runtime:{baseDir:dir,reportsDir:path.join(dir,'reports')},safety:{maxExecuteActions:100},sites:{arclc:{enabled:true,implementationStatus:'ready',organizationLabel:'ALLCPR Inc.'},aha:{enabled:true,implementationStatus:'ready',organizationId:'32238',coverageVerified:true,maxBatchActions:100}}};
  const app=await startLocalServer({config});
  const headers={Authorization:'Bearer '+app.token,'Content-Type':'application/json'};
  try {
    const state=await(await fetch(app.origin+'/api/state',{headers})).json();
    assert.equal(state.maxFileBytes,50*1024*1024);assert.equal(state.maxFileMb,50);
    assert.equal(state.maxBatch,100);assert.equal(state.sites.arclc.maxBatch,100);assert.equal(state.sites.aha.maxBatch,100);
    const response=await fetch(app.origin+'/api/import',{method:'POST',headers,body:JSON.stringify({fileName:'large.csv',dataBase64:largeRoster(10*1024*1024).toString('base64')})});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.accepted.length,1);
    assert.deepEqual(app.coordinator.state().browsers,[]);
  } finally {await app.close();}
});

test('deferral and Finder endpoints require authentication and bind to a stored task, never a supplied file path',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'offboarding-review-http-'));
  const config={runtime:{baseDir:dir,reportsDir:path.join(dir,'reports')},safety:{maxExecuteActions:10},sites:{arclc:{enabled:true,implementationStatus:'ready',organizationLabel:'ALLCPR Inc.'},aha:{enabled:true,implementationStatus:'ready',organizationId:'32238',coverageVerified:true}}};
  const revealed=[];const app=await startLocalServer({config,revealFile:async file=>revealed.push(file)});
  const headers={Authorization:'Bearer '+app.token,'Content-Type':'application/json'};
  const post=(route,body,h=headers)=>fetch(app.origin+'/api/'+route,{method:'POST',headers:h,body:JSON.stringify(body)});
  try {
    const state=await(await fetch(app.origin+'/api/state',{headers})).json();
    assert.equal(state.deferredReviewVersion,1);assert.equal(state.revealResultVersion,1);
    for(const route of ['defer','reveal-result']) {
      assert.equal((await post(route,{}, {'Content-Type':'application/json'})).status,401);
      assert.equal((await post(route,{}, {...headers,Origin:'https://example.invalid'})).status,403);
    }
    const preview=await(await post('import',{fileName:'synthetic.csv',dataBase64:Buffer.from('Full Name,Email\nTest Person,test@example.com').toString('base64')})).json();
    const job=await(await post('create',{previewId:preview.previewId,platforms:['arclc']})).json();
    job.items[0].status='MANUAL_REVIEW';job.items[0].detail='Name mismatch';await app.coordinator.store.save(job);
    const body={id:job.id,email:'test@example.com',platform:'arclc',expectedStatus:'MANUAL_REVIEW',expectedDetail:'Name mismatch',expectedCheckedAt:'',reason:'Verify source separately',confirmation:`DEFER:${job.id}:arclc:test@example.com`};
    assert.equal((await post('defer',{...body,confirmation:''})).status,400);
    assert.equal((await post('defer',body)).status,200);
    assert.equal((await app.coordinator.store.load(job.id)).items[0].status,'DEFERRED');
    assert.equal((await post('reveal-result',{id:job.id})).status,400);
    const exported=await(await post('export',{id:job.id})).json();
    assert.equal((await post('reveal-result',{id:job.id,filePath:'/etc/passwd'})).status,200);
    assert.deepEqual(revealed,[await realpath(exported.filePath)]);assert.deepEqual(app.coordinator.state().browsers,[]);
  } finally {await app.close();}
});

test('API exposes AHA readiness and automatic protections; omitted client exclusions never re-enable protected people', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'offboarding-protected-http-'));
  const config = {runtime:{baseDir:dir,reportsDir:path.join(dir,'reports')}, safety:{maxExecuteActions:10,protectedTeachers:[{fullName:'Protected Person',email:'keep@example.com',reason:'User excluded'}]}, sites:{arclc:{enabled:true,implementationStatus:'ready',organizationLabel:'ALLCPR Inc.'},aha:{enabled:true,implementationStatus:'ready',organizationId:'32238',coverageVerified:true,maxBatchActions:3}}};
  const app = await startLocalServer({config});
  const headers = {Authorization:'Bearer '+app.token,'Content-Type':'application/json'};
  const post = (route, body) => fetch(app.origin+'/api/'+route, {method:'POST',headers,body:JSON.stringify(body)});
  try {
    const state = await (await fetch(app.origin+'/api/state',{headers})).json();
    assert.equal(state.protectedExclusionVersion,1);
    assert.equal(state.sites.aha.ready,true);
    assert.equal(state.sites.aha.maxBatch,3);
    const preview = await (await post('import',{fileName:'synthetic.csv',dataBase64:Buffer.from('Full Name,Email\nProtected Person,keep@example.com\nDeparted Person,leave@example.com\n').toString('base64')})).json();
    assert.deepEqual(preview.protectedExclusions.map(t=>t.email),['keep@example.com']);
    const job = await (await post('create',{previewId:preview.previewId,platforms:['arclc','aha'],excludedEmails:[]})).json();
    assert.equal(job.items.length,2);
    assert.ok(job.items.every(t=>t.email==='leave@example.com'));
    assert.equal(job.excludedTeachers[0].protected,true);
    assert.deepEqual(app.coordinator.state().browsers,[]);
  } finally { await app.close(); }
});

test('loopback API rejects missing token and foreign origins; input stays local and no login is triggered by import', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'offboarding-http-'));
  const config={runtime:{baseDir:dir,reportsDir:path.join(dir,'reports')},safety:{maxExecuteActions:10},sites:{arclc:{enabled:true,implementationStatus:'ready',organizationLabel:'ALLCPR Inc.'},aha:{enabled:true,implementationStatus:'discovery_complete',organizationId:'32238',coverageVerified:false}}};
  const app=await startLocalServer({config});
  const headers={Authorization:'Bearer '+app.token,'Content-Type':'application/json'};
  try {
    assert.equal((await fetch(app.origin+'/api/jobs')).status,401);
    assert.equal((await fetch(app.origin+'/api/jobs',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
    // fetch normalizes Host; a raw HTTP request exercises the rebinding guard.
    const forgedHostStatus=await new Promise((resolve,reject)=>{
      const request=http.get(app.origin+'/api/jobs',{headers:{...headers,Host:'untrusted.example'}},response=>{response.resume();resolve(response.statusCode);});
      request.on('error',reject);
    });
    assert.equal(forgedHostStatus,403);
    const result=await fetch(app.origin+'/api/import',{method:'POST',headers,body:JSON.stringify({fileName:'synthetic.csv',dataBase64:Buffer.from('Full Name,Email\nExample Teacher,test@example.com').toString('base64')})});
    assert.equal(result.status,200); const roster=await result.json();
    assert.equal(roster.accepted.length,1);
    assert.deepEqual(app.coordinator.state().browsers,[]);
    const create=await fetch(app.origin+'/api/create',{method:'POST',headers,body:JSON.stringify({previewId:roster.previewId,platforms:['arclc']})});
    assert.equal(create.status,200); const job=await create.json();
    const exported=await fetch(app.origin+'/api/export',{method:'POST',headers,body:JSON.stringify({id:job.id})});
    assert.equal(exported.status,200); assert.match(await readFile((await exported.json()).filePath,'utf8'),/test@example.com/);
    const start=await fetch(app.origin+'/api/start',{method:'POST',headers,body:JSON.stringify({id:job.id,mode:'execute',limit:1,confirmation:'UNALIGN:'+job.id})});
    assert.equal(start.status,400); assert.match((await start.json()).error,/Open the/);
    const reused=await fetch(app.origin+'/api/create',{method:'POST',headers,body:JSON.stringify({previewId:roster.previewId,platforms:['arclc']})});
    assert.equal(reused.status,400);
  } finally {await app.close();}
});

test('create API filters trusted preview by explicit exclusions and retains the decision after reopening', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'offboarding-exclusion-http-'));
  const config = {runtime:{baseDir:dir,reportsDir:path.join(dir,'reports')},safety:{maxExecuteActions:10},sites:{arclc:{enabled:true,implementationStatus:'ready',organizationLabel:'ALLCPR Inc.'},aha:{enabled:true,implementationStatus:'discovery_complete',organizationId:'32238',coverageVerified:false}}};
  const app = await startLocalServer({config});
  const headers = {Authorization:'Bearer '+app.token,'Content-Type':'application/json'};
  const post = (route, body) => fetch(app.origin+'/api/'+route, {method:'POST', headers, body:JSON.stringify(body)});
  try {
    assert.equal((await (await fetch(app.origin+'/api/state', {headers})).json()).previewExclusionVersion, 1);
    const roster = await (await post('import', {fileName:'synthetic.csv', dataBase64:Buffer.from('Full Name,Email\nSame Name,keep@example.com\nSame Name,departed@example.com\n').toString('base64')})).json();
    const body = {previewId:roster.previewId, platforms:['arclc']};
    for (const excludedEmails of [['unknown@example.com'], ['keep@example.com','departed@example.com'], null]) {
      assert.equal((await post('create', {...body, excludedEmails})).status, 400);
    }
    const response = await post('create', {...body, excludedEmails:['keep@example.com'], accepted:[{email:'injected@example.com'}]});
    assert.equal(response.status, 200);
    const job = await response.json();
    assert.deepEqual(job.items.map(i => i.email), ['departed@example.com'], 'same names are not used as exclusion keys');
    const reopened = await (await fetch(app.origin+'/api/job?id='+job.id, {headers})).json();
    assert.equal(reopened.excludedTeachers[0].email, 'keep@example.com');
    assert.equal(reopened.items.length, 1);
    const report = await (await post('export', {id:job.id})).json();
    assert.match(await readFile(report.filePath, 'utf8'), /EXCLUDED/);
    assert.deepEqual(app.coordinator.state().browsers, []);
  } finally { await app.close(); }
});
