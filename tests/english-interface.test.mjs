import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

test('distributed UI, launchers and user documentation are English',async()=>{
  for(const file of ['ui/index.html','ui/app.js','ui/execution-state.js','README.md','LOCAL-APP.md','SECURITY.md','start.command','test-app.command','scripts/init.mjs','scripts/launch.mjs']) {
    const text=await readFile(new URL('../'+file,import.meta.url),'utf8');
    assert.doesNotMatch(text,/\p{Script=Han}/u,file);
  }
  const html=await readFile(new URL('../ui/index.html',import.meta.url),'utf8');
  assert.match(html,/<html lang="en">/);
  for(const label of ['Read Roster','Exclude from Job','Save Local Job','Check Login / Open ARCLC','Check Login / Open AHA','Inspect Unfinished Items','Execute Next Batch','Export Results CSV','Confirm Deferral']) assert.ok(html.includes(label),label);
});

test('backend Chinese literals are limited to input compatibility and website safety detection',async()=>{
  const allowed={
    'src/local/import.mjs':/^\s*(fullName|email|achievement): \[/,
    'src/session-check.mjs':/^const expiredText = /,
    'src/platforms/arclc-coverage.mjs':/next.*load more.*show more/
  };
  async function walk(dir){for(const entry of await readdir(new URL('../'+dir,import.meta.url),{withFileTypes:true})){
    const file=dir+'/'+entry.name;if(entry.isDirectory()){await walk(file);continue;}
    if(file==='src/aha-acceptance.mjs'||!file.match(/\.(mjs|py)$/))continue;
    const text=await readFile(new URL('../'+file,import.meta.url),'utf8');
    for(const line of text.split('\n')) if(/\p{Script=Han}/u.test(line)) assert.ok(allowed[file]?.test(line),'Unexpected untranslated message in '+file);
  }}
  await walk('src');
});
