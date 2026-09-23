import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {revealResult} from '../src/local/reveal.mjs';

test('Finder reveal accepts only an existing exported CSV and never client-supplied arbitrary paths',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'offboarding-reveal-'));const reports=path.join(root,'reports');
  await mkdir(path.join(reports,'results'),{recursive:true});
  const id=randomUUID(),file=path.join(reports,'results','offboarding-'+id+'.csv'),seen=[];
  const reveal=async file=>seen.push(file);
  await assert.rejects(revealResult(id,reports,reveal),/Export the current/);
  await assert.rejects(revealResult('../../config.json',reports,reveal),/job ID/);
  await writeFile(file,'synthetic');await revealResult(id,reports,reveal);
  assert.deepEqual(seen,[await realpath(file)]);
  const symlinkId=randomUUID();await symlink(file,path.join(reports,'results','offboarding-'+symlinkId+'.csv'));
  await assert.rejects(revealResult(symlinkId,reports,reveal),/regular file/);
  const other=path.join(root,'other');await mkdir(other);await writeFile(path.join(other,'offboarding-'+id+'.csv'),'outside');
  const linkedReports=path.join(root,'linked-reports');await mkdir(linkedReports);await symlink(other,path.join(linkedReports,'results'));
  await assert.rejects(revealResult(id,linkedReports,reveal),/outside/);assert.equal(seen.length,1);
});
