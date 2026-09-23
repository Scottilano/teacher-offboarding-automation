import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

// Execute the actual shipped import and control functions, not a reimplementation.
const source=await readFile(new URL('../ui/app.js',import.meta.url),'utf8');
const controls=source.slice(source.indexOf('function updateControls()'),source.indexOf('function renderPreview()'));
const importer=source.slice(source.indexOf('async function readInput('),source.indexOf('async function refresh()'));
const change=source.split('\n').find(line=>line.startsWith("$('file').addEventListener('change'"));
function fixture() {
  const nodes=new Map(),requests=[],readers=[];
  const $=id=>{
    if(!nodes.has(id)) nodes.set(id,{value:id==='limit'?'10':'',checked:false,disabled:false,files:[],hidden:false,
      addEventListener(event,fn){this[event]=fn;},replaceChildren(){}});
    return nodes.get(id);
  };
  const context=vm.createContext({$,document:{querySelectorAll:()=>[]},preview:null,job:null,
    state:{busy:false,previewExclusionVersion:1,protectedExclusionVersion:1,sites:{aha:{ready:true}},maxBatch:10},
    creating:false,importing:false,importGeneration:0,pendingDeferral:null,lastExportJob:null,excludedEmails:new Set(),
    executionState:()=>({disabled:false,reason:''}),done:()=>false,renderPreview:()=>{},message:()=>{},
    api:(route,body)=>new Promise((resolve,reject)=>requests.push({route,body,resolve,reject})),
    FileReader:class {readAsDataURL(){readers.push(this);}}});
  vm.runInContext(controls+'\n'+importer+'\n'+change,context);
  return {context,$,requests,readers,read:()=>vm.runInContext('readInput()',context),
    choose(name){$('file').files=[{name,size:10}];$('file').change();},
    async finishRead(){const r=readers.shift();r.result='data:text/csv;base64,AAAA';r.onload();await Promise.resolve();}};
}
test('UI locks import controls through polling, accepts only current preview, and recovers from errors',async()=>{
  const f=fixture();f.choose('A.csv');const pending=f.read();
  vm.runInContext('updateControls()',f.context);
  for(const id of ['file','import','read-sheet','create','load','arc','aha','execute']) assert.equal(f.$(id).disabled,true,id);
  await f.read();assert.equal(f.readers.length,1,'double invocation cannot enqueue another import');
  await f.finishRead();f.requests[0].resolve({previewId:'A',accepted:[],rejected:[]});await pending;
  assert.equal(f.context.preview.previewId,'A');assert.equal(f.$('file').disabled,false);
  f.choose('bad.csv');const bad=f.read();await f.finishRead();f.requests[1].reject(new Error('invalid source'));
  await assert.rejects(bad,/invalid source/);assert.equal(f.context.importing,false);assert.equal(f.$('file').disabled,false);
});
test('late A response cannot replace B preview or unlock B import; old file read never sends request',async()=>{
  const f=fixture();f.choose('A.csv');const a=f.read();await f.finishRead();
  f.choose('B.csv');const b=f.read();await f.finishRead();
  f.requests[0].resolve({previewId:'A',accepted:[],rejected:[]});await a;
  assert.equal(f.context.preview,null);assert.equal(f.context.importing,true);assert.equal(f.$('file').disabled,true);
  f.requests[1].resolve({previewId:'B',accepted:[],rejected:[]});await b;
  assert.equal(f.context.preview.previewId,'B');assert.equal(f.context.importing,false);
  f.choose('old.csv');const old=f.read();f.choose('new.csv');await f.finishRead();await old;
  assert.equal(f.requests.length,2);assert.equal(f.context.preview,null);
});

test('UI takes 50 MB and 100-action limits from server without changing default batch 10',async()=>{
  const f=fixture();Object.assign(f.context.state,{maxFileMb:50,maxFileBytes:50*1024*1024,maxBatch:100,sites:{aha:{ready:true,maxBatch:100},arclc:{ready:true,maxBatch:100}}});
  f.context.job={id:'synthetic',items:[{platform:'aha',status:'PENDING'}]};
  vm.runInContext('updateControls()',f.context);
  assert.equal(f.$('limit').max,100);assert.equal(f.$('limit').value,'10');assert.match(f.$('file-limit').textContent,/50 MB/);
  f.$('limit').value='100';vm.runInContext('updateControls()',f.context);assert.equal(f.$('limit').value,'100');
  f.choose('large.csv');f.$('file').files[0].size=50*1024*1024;const pending=f.read();await f.finishRead();
  f.requests[0].resolve({accepted:[],rejected:[]});await pending;
  f.choose('too-large.csv');f.$('file').files[0].size=50*1024*1024+1;
  await assert.rejects(f.read(),/50 MB/);assert.equal(f.requests.length,1);
});
