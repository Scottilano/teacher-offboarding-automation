import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function createRunId() {
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export function buildPlan(teachers, rejected, config) {
  const runId = createRunId();
  const items = [];
  for (const teacher of teachers) {
    if (config.sites.aha.enabled && teacher.processAha) {
      items.push({ ...teacher, platform: 'aha', organizationId: config.sites.aha.organizationId, action: 'UNALIGN', status: 'PLANNED' });
    }
    if (config.sites.arclc.enabled && teacher.processArclc) {
      items.push({ ...teacher, platform: 'arclc', organization: config.sites.arclc.organizationLabel, action: 'UNALIGN', status: 'PLANNED' });
    }
  }
  return {
    schemaVersion: 2,
    runId,
    createdAt: new Date().toISOString(),
    spreadsheetId: config.source.spreadsheetId,
    sheetName: config.source.sheetName,
    items,
    rejected
  };
}

export async function savePlan(plan, directory) {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${plan.runId}.plan.json`);
  await writeFile(filePath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export async function loadPlan(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}
