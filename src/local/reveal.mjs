import {lstat,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
const exec=promisify(execFile);
export async function revealResult(id,reportsDir, reveal=async file=>{
  if(process.platform!=='darwin') throw new Error('This feature requires macOS Finder.');
  await exec('/usr/bin/open',['-R',file]);
}) {
  if(!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid job ID.');
  const file=path.join(reportsDir,'results','offboarding-'+id+'.csv');
  const info=await lstat(file).catch(()=>{throw new Error('Export the current job results CSV first.');});
  if(!info.isFile() || info.isSymbolicLink()) throw new Error('The exported result is not a regular file and cannot be opened.');
  const reports=await realpath(reportsDir), actual=await realpath(file);
  if(path.dirname(actual)!==path.join(reports,'results')) throw new Error('The result file is outside the allowed export directory.');
  await reveal(actual);
  return {revealed:true};
}
