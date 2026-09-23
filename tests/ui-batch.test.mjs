import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {executionState} from '../ui/execution-state.js';

// Exercise shipped controls, refresh and start handlers with deferred responses.
const source = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const controls = source.slice(source.indexOf('function updateControls()'), source.indexOf('function renderPreview()'));
const refresh = source.slice(source.indexOf('async function refresh()'), source.indexOf('function on('));
const start = source.slice(source.indexOf("for (const [id, mode] of [['inspect'"), source.indexOf("on('stop'"));
const tick = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
function fixture() {
  const nodes = new Map(), requests = [], handlers = {};
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, {checked:false,disabled:false,value:id==='limit'?'3':'',textContent:''});
    return nodes.get(id);
  };
  const idle = {busy:false,browsers:['arclc','aha'],sites:{arclc:{ready:true,maxBatch:3},aha:{ready:true,maxBatch:3}},maxBatch:3};
  const context = vm.createContext({$, document:{querySelectorAll:()=>[]},
    state:structuredClone(idle), job:{id:'synthetic-job',items:[{platform:'aha',status:'PENDING'}]},
    preview:null,creating:false,importing:false,starting:false,wasBusy:false,polling:false,
    pendingDeferral:null,lastExportJob:null,executionState,done:s=>s==='REMOVED',message:()=>{},
    api:(route,body)=>new Promise((resolve,reject)=>requests.push({route,body,resolve,reject})),
    on:(id,fn)=>{handlers[id]=fn;},renderJob:()=>vm.runInContext('updateControls()',context),
    historyList:()=>context.api('jobs')});
  vm.runInContext(controls+'\n'+refresh+'\n'+start,context);
  return {$,context,idle,handlers,requests,
    update:()=>vm.runInContext('updateControls()',context),
    refresh:()=>vm.runInContext('refresh()',context),
    take(route){const request=requests.shift();assert.equal(request?.route,route);return request;}};
}

test('authorization stays locked across running, final-result and delayed-history phases',async()=>{
  const f=fixture(); f.context.wasBusy=true; f.context.state.busy=true;
  f.update(); assert.equal(f.$('approved').disabled,true);
  const pending=f.refresh(); f.take('state').resolve(f.idle); await tick();
  // State already says idle, but the final job snapshot has not arrived.
  f.update(); assert.equal(f.$('approved').disabled,true); assert.equal(f.$('execute').disabled,true);
  f.take('job?id=synthetic-job').resolve({id:'synthetic-job',items:[{platform:'aha',status:'PENDING'}]}); await tick();
  const history=f.take('jobs');
  assert.equal(f.$('approved').disabled,true,'rendering the result must not unlock approval');
  assert.equal(f.$('approved').checked,false);
  history.resolve([]); await pending;
  assert.equal(f.$('approved').disabled,false); assert.equal(f.$('execute').disabled,true);
  f.$('approved').checked=true; f.update(); assert.equal(f.$('execute').disabled,false);
  const next=f.refresh(); f.take('state').resolve(f.idle); await next;
  assert.equal(f.$('approved').checked,true,'a later idle poll must preserve fresh authorization');
  assert.equal(f.$('execute').disabled,false);
});

test('start consumes authorization immediately and blocks duplicates while its response is delayed',async()=>{
  const f=fixture(); f.$('approved').checked=true;
  const pending=f.handlers.execute(); const request=f.take('start');
  assert.equal(request.body.confirmation,'UNALIGN:synthetic-job');
  assert.equal(f.$('approved').checked,false); assert.equal(f.$('approved').disabled,true);
  f.update(); assert.equal(f.$('execute').disabled,true,'unrelated UI updates cannot unlock a pending start');
  await assert.rejects(f.handlers.execute(),/Wait for the current operation/);
  assert.equal(f.requests.length,0,'no duplicate start request');
  request.reject(new Error('Synthetic start failure'));
  await assert.rejects(pending,/Synthetic start failure/);
  assert.equal(f.context.starting,false); assert.equal(f.$('approved').disabled,false);
  assert.equal(f.$('approved').checked,false); assert.equal(f.$('execute').disabled,true);
});

test('failed final history refresh stays locked until a complete retry succeeds',async()=>{
  const f=fixture(); f.context.wasBusy=true;
  const pending=f.refresh(); f.take('state').resolve(f.idle); await tick();
  f.take('job?id=synthetic-job').resolve(f.context.job); await tick();
  f.take('jobs').reject(new Error('Synthetic history failure')); await pending;
  f.update(); assert.equal(f.$('approved').disabled,true); assert.equal(f.$('execute').disabled,true);
  const retry=f.refresh(); f.take('state').resolve(f.idle); await tick();
  f.take('job?id=synthetic-job').resolve(f.context.job); await tick();
  f.take('jobs').resolve([]); await retry;
  assert.equal(f.$('approved').disabled,false); assert.equal(f.$('approved').checked,false);
  assert.equal(f.$('execute').disabled,true);
});
