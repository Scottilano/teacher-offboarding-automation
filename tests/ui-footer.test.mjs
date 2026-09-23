import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {loadConfig} from '../src/config.mjs';

const html=await readFile(new URL('../ui/index.html',import.meta.url),'utf8');
const script=await readFile(new URL('../ui/app.js',import.meta.url),'utf8');

test('footer omits retired explanations; refresh still displays the running server report directory',async()=>{
  assert.doesNotMatch(html,/id="availability"|Completed items are skipped only within the same job/);
  assert.doesNotMatch(script,/\$\('availability'\)/);
  const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],{}]));
  const $=id=>{assert.ok(nodes.has(id),'Missing UI element: '+id);return nodes.get(id);};
  const errors=[];
  const serverState={reportsDir:'/Users/another-user/Teacher Tool/reports',maxBatch:100,browsers:[],busy:false};
  const context=vm.createContext({$,polling:false,state:null,job:null,wasBusy:false,
    api:async()=>serverState,updateControls:()=>{},message:text=>errors.push(text)});
  vm.runInContext(script.slice(script.indexOf('async function refresh()'),script.indexOf('function on(')),context);
  await vm.runInContext('refresh()',context);
  assert.deepEqual(errors,[]);
  assert.equal($('storage').textContent,'Local audit directory: '+serverState.reportsDir);
  assert.equal(context.polling,false);
});

test('report directory follows config installation location, not an old saved absolute path',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'offboarding-relocated-'));
  const file=path.join(directory,'config.json');
  await writeFile(file,JSON.stringify({safety:{maxExecuteActions:100},browser:{profileRoot:'./data/browser-profiles'},sites:{},runtime:{reportsDir:'/old-installation/reports'}}));
  const config=await loadConfig(file,{localOnly:true});
  assert.equal(config.runtime.reportsDir,path.join(directory,'reports'));
  assert.equal(config.runtime.baseDir,directory);
});
