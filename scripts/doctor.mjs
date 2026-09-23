import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {pythonExecutable,projectRoot} from '../src/runtime.mjs';
import path from 'node:path';
let ok=true;
function check(label,pass,detail){console.log(`${pass?'OK':'FAIL'} ${label}: ${detail}`);if(!pass)ok=false;}
check('Node',Number(process.versions.node.split('.')[0])>=22,process.version+' (required >=22)');
const python=pythonExecutable();
const result=spawnSync(python,['-c','import sys,openpyxl; assert sys.version_info >= (3,10); print(sys.version.split()[0], "openpyxl",openpyxl.__version__)'],{encoding:'utf8'});
check('Python + openpyxl',result.status===0,result.status===0?result.stdout.trim():'Install Python 3.10+ and pip install -r requirements.txt; or set OFFBOARDING_PYTHON.');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(projectRoot,'data','ms-playwright');
try {const {chromium}=await import('playwright');check('Chromium installed',existsSync(chromium.executablePath()),'Run npm run browsers:install if missing.');}
catch {check('Playwright',false,'Run npm ci first.');}
console.log(existsSync(path.join(projectRoot,'config.json'))?'OK local config exists':'INFO run npm run init to create local config');
console.log('Browser presence is not a successful browser launch or website acceptance test.');
process.exitCode=ok?0:1;
