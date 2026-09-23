import {mkdir,mkdtemp,readdir,lstat,readFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {projectRoot} from '../src/runtime.mjs';
const rootFiles=['.gitignore','.nvmrc','.env.example','package.json','package-lock.json','requirements.txt','config.example.json','README.md','LOCAL-APP.md','SECURITY.md','start.command','test-app.command'];
const roots=['src','ui','tests','scripts','.github'];
const excluded=new Set(['src/aha-acceptance.mjs','tests/aha-acceptance.test.mjs','tests/browser/synthetic-roster.csv','tests/fixtures/preview-exclusions.csv']);
const files=[...rootFiles];
async function walk(relative) {
  const info=await lstat(path.join(projectRoot,relative));
  if(!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing non-directory source root: '+relative);
  for(const entry of await readdir(path.join(projectRoot,relative),{withFileTypes:true})) {
    const name=relative+'/'+entry.name;
    if(excluded.has(name)||entry.name==='__pycache__')continue;
    if(entry.isSymbolicLink()) throw new Error('Refusing symlink: '+name);
    if(entry.isDirectory()) await walk(name);
    else if(/\.(mjs|js|py|html|css|yml|yaml)$/.test(entry.name)) files.push(name);
    else throw new Error('Unexpected source file; review allowlist: '+name);
  }
}
for(const root of roots) await walk(root);
for(const name of files) {
  const full=path.join(projectRoot,name);if(!(await lstat(full)).isFile())throw new Error('Not a regular source file: '+name);
  const text=await readFile(full,'utf8');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /\/Users\/[^/\s]+\/(?:Documents|\.cache)\//.test(text)) throw new Error('Potential private material: '+name);
  // npm's pinned public dependency metadata includes upstream author email addresses.
  const emails=name==='package-lock.json'?[]:text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)||[];
  if(emails.some(email=>!/@(?:example\.(?:com|org|net|invalid)|test\.invalid)$/i.test(email))) throw new Error('Non-synthetic email requires review: '+name);
}
await mkdir(path.join(projectRoot,'dist'),{recursive:true});
const output=await mkdtemp(path.join(projectRoot,'dist','company-repo-'));
for(const name of files) {const target=path.join(output,name);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(projectRoot,name),target);}
console.log(`Clean source: ${output}\nFiles: ${files.length}\nNo config, sessions, rosters, historical reports or runtime overrides included. Review before uploading.`);
