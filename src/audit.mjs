import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import {persistEvidence} from './evidence.mjs';

export const TERMINAL_RESULTS = new Set(['REMOVED', 'ABSENT_VERIFIED']);

export async function writeLocalAudit(config, record) {
  const directory = path.join(config.runtime.reportsDir, 'audit');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'events.jsonl');
  const handle = await open(file, 'a', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  return file;
}

// Write intent durably BEFORE any site mutation, and record failures as well as
// success. Cloud audit failures must not erase an already-performed action.
export async function runAuditedAction({ config, item, runId, action, sync }) {
  const base = { ...item, runId, action: 'UNALIGN' };
  await writeLocalAudit(config, { ...base, result: 'STARTED' });
  let result;
  try { result = await action(); }
  catch (error) { result = { status: 'ERROR', detail: error.message }; }
  result = await persistEvidence(config,item,result,runId);
  const record = { ...base, timestamp: new Date().toISOString(), result: result.status, detail: result.detail,
    ...(result.evidence ? {evidence:result.evidence,evidencePath:result.evidencePath} : {}) };
  const auditPath = await writeLocalAudit(config, record);
  if (sync) {
    try { await sync(record); }
    catch (error) {
      await writeLocalAudit(config, { ...base, result: 'AUDIT_SYNC_FAILED', detail: error.message });
      throw new Error(`Site result ${result.status} saved to ${auditPath}; Sheet audit failed: ${error.message}. Batch stopped.`);
    }
  }
  return { ...result, auditPath };
}
