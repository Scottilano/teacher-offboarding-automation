import {spawn} from 'node:child_process';
import path from 'node:path';
import {projectRoot} from '../src/runtime.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(projectRoot,'data','ms-playwright');
const args=['node_modules/playwright/cli.js','install',...(process.argv.includes('--with-deps')?['--with-deps']:[]),'chromium'];
const child=spawn(process.execPath,args,{stdio:'inherit',env:process.env});
child.on('exit',code=>{process.exitCode=code??1;});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
