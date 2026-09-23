import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const projectRoot=fileURLToPath(new URL('../',import.meta.url));
export function pythonExecutable() {
  if(process.env.OFFBOARDING_PYTHON) return process.env.OFFBOARDING_PYTHON;
  const local=path.join(projectRoot,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  return existsSync(local)?local:process.platform==='win32'?'python':'python3';
}
