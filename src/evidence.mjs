import {mkdir,open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

export async function persistEvidence(config,item,result,runId) {
  if (!result.evidence) return result;
  const directory=path.join(config.runtime.reportsDir,'verification');
  await mkdir(directory,{recursive:true,mode:0o700});
  const evidencePath=path.join(directory,'verification-'+randomUUID()+'.json');
  const handle=await open(evidencePath,'wx',0o600);
  try {
    await handle.writeFile(JSON.stringify({schemaVersion:1,checkedAt:new Date().toISOString(),runId,
      platform:item.platform,email:item.email,fullName:item.fullName,organization:item.organization||item.organizationId,
      status:result.status,detail:result.detail,views:result.evidence},null,2)+'\n');
    await handle.sync();
  } finally {await handle.close();}
  return {...result,evidencePath};
}
