import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function printPlanSummary(plan) {
  const counts = plan.items.reduce((acc, item) => {
    acc[item.platform] = (acc[item.platform] || 0) + 1;
    return acc;
  }, {});
  console.log('\nDRY-RUN SUMMARY');
  console.log(`Run ID: ${plan.runId}`);
  console.log(`AHA actions: ${counts.aha || 0}`);
  console.log(`ARCLC actions: ${counts.arclc || 0}`);
  console.log(`Rejected/manual review rows: ${plan.rejected.length}`);
  console.table(plan.items.map(item => ({
    rows: item.sourceRows.join(','),
    name: item.fullName,
    email: item.email,
    achievements: item.achievements.join('; '),
    platform: item.platform,
    organization: item.organization || item.organizationId,
    action: item.action
  })));
  if (plan.rejected.length) {
    console.log('\nRows not eligible for automation:');
    console.table(plan.rejected.map(item => ({
      rows: item.sourceRows?.join(',') || item.rowNumber,
      name: item.fullName,
      email: item.email,
      reasons: item.reasons.join(', ')
    })));
  }
}

export async function writeMarkdownReport(plan, directory) {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${plan.runId}.dry-run.md`);
  const lines = [
    '# Teacher Offboarding Dry Run',
    '',
    `- Run ID: \`${plan.runId}\``,
    `- Created: ${plan.createdAt}`,
    `- Planned platform actions: ${plan.items.length}`,
    `- Rejected/manual-review rows: ${plan.rejected.length}`,
    '',
    '| Source rows | Name | Email | Achievement(s) | Platform | Organization | Action |',
    '|---:|---|---|---|---|---|---|',
    ...plan.items.map(item => `| ${item.sourceRows.join(',')} | ${item.fullName} | ${item.email} | ${item.achievements.join('; ')} | ${item.platform.toUpperCase()} | ${item.organization || item.organizationId} | ${item.action} |`),
    '',
    '## Manual review',
    '',
    '| Source row | Name | Email | Reasons |',
    '|---:|---|---|---|',
    ...plan.rejected.map(item => `| ${item.sourceRows?.join(',') || item.rowNumber} | ${item.fullName} | ${item.email} | ${item.reasons.join(', ')} |`),
    ''
  ];
  await writeFile(filePath, lines.join('\n'), { mode: 0o600 });
  return filePath;
}
