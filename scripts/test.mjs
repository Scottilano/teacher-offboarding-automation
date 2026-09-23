import {readdirSync,mkdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
if(Number(process.versions.node.split('.')[0])<22) throw new Error('Tests require Node 22+.');
const legacy=new Set(['aha-acceptance.test.mjs']);
mkdirSync('reports',{recursive:true});
const browser=process.argv.includes('--browser');
const files=browser ? ['local-ui.mjs','session-fixture.mjs','aha-fixture.mjs','fixture.mjs'].map(name=>'tests/browser/'+name)
  : readdirSync('tests').filter(name=>name.endsWith('.test.mjs')&&!legacy.has(name)).sort().map(name=>'tests/'+name);
const child=spawn(process.execPath,['--test',...files],{stdio:'inherit',env:process.env});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
