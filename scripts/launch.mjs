// Small bootstrap also runs on older Node so it can give an actionable error.
import {readFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const targets={start:'src/local/server.mjs',test:'scripts/test.mjs',doctor:'scripts/doctor.mjs',init:'scripts/init.mjs',browsers:'scripts/browsers.mjs',export:'scripts/export-source.mjs'};
const target=targets[process.argv[2]];
if(!target) throw new Error('Unknown launcher command.');
const localFile=path.join(root,'.runtime.local.json');
const local=existsSync(localFile)?JSON.parse(readFileSync(localFile,'utf8')):{};
const node=process.env.OFFBOARDING_NODE || local.node || process.execPath;
const env={...process.env};
if(!env.OFFBOARDING_PYTHON && local.python) env.OFFBOARDING_PYTHON=local.python;
const child=spawn(node,[path.join(root,target),...process.argv.slice(3)],{cwd:root,env,stdio:'inherit'});
child.on('error',()=>{console.error('Unable to start Node. Install Node 22+ or set OFFBOARDING_NODE.');process.exitCode=1;});
child.on('exit',(code)=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{if(!child.killed) child.kill(signal);});
