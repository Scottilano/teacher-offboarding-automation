import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pythonExecutable} from '../src/runtime.mjs';

test('Python runtime accepts an explicit local interpreter without a bundled-agent dependency',()=>{
  const previous=process.env.OFFBOARDING_PYTHON;
  try {process.env.OFFBOARDING_PYTHON='custom-python-command';assert.equal(pythonExecutable(),'custom-python-command');}
  finally {if(previous===undefined)delete process.env.OFFBOARDING_PYTHON;else process.env.OFFBOARDING_PYTHON=previous;}
});
test('public launchers have no personal runtime paths and git excludes local secrets and history',async()=>{
  for(const file of ['start.command','test-app.command','src/runtime.mjs','scripts/launch.mjs']) {
    const text=await readFile(new URL('../'+file,import.meta.url),'utf8');
    assert.doesNotMatch(text,/\/Users\/|codex-runtimes/);
  }
  const ignored=await readFile(new URL('../.gitignore',import.meta.url),'utf8');
  for(const entry of ['config.json','.runtime.local.json','data/','reports/','plans/','secrets/','.venv/','dist/','/src/aha-acceptance.mjs']) assert.ok(ignored.split('\n').includes(entry));
  const template=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url),'utf8'));
  assert.ok(template.source.spreadsheetId.startsWith('PASTE_'));
  assert.equal(template.sites.aha.coverageVerified,false);
  assert.ok(Object.values(template.sites).every(site=>site.implementationStatus==='discovery_complete'));
});
