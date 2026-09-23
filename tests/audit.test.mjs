import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAuditedAction, TERMINAL_RESULTS } from '../src/audit.mjs';

test('intent and failure are durable and uncertain statuses are not terminal', async () => {
  const reportsDir = await mkdtemp(path.join(os.tmpdir(), 'offboarding-audit-test-'));
  const config = { runtime: { reportsDir } };
  const file = path.join(reportsDir, 'audit/events.jsonl');
  const result = await runAuditedAction({ config, item: { email: 'test@example.com' }, runId: 'test', action: async () => {
    assert.equal(JSON.parse((await readFile(file, 'utf8')).trim()).result, 'STARTED');
    throw new Error('Simulated failure');
  } });
  assert.equal(result.status, 'ERROR');
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.result), ['STARTED', 'ERROR']);
  for (const status of ['SUBMITTED', 'UNVERIFIED', 'MANUAL_REVIEW', 'NOT_FOUND', 'ERROR']) assert.equal(TERMINAL_RESULTS.has(status), false);
});

test('cloud audit failure retains removal outcome locally and throws to stop batch', async () => {
  const reportsDir = await mkdtemp(path.join(os.tmpdir(), 'offboarding-sync-test-'));
  await assert.rejects(() => runAuditedAction({ config: { runtime: { reportsDir } }, item: { email: 'test@example.com' }, runId: 'test', action: async () => ({ status: 'REMOVED' }), sync: async () => { throw new Error('offline'); } }), /Batch stopped/);
  const rows = (await readFile(path.join(reportsDir, 'audit/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.result), ['STARTED', 'REMOVED', 'AUDIT_SYNC_FAILED']);
});
