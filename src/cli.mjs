#!/usr/bin/env node
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from './config.mjs';
import { readTeacherRows, appendAuditRows, ensureAuditSheet } from './google-sheets.mjs';
import { runAuditedAction, TERMINAL_RESULTS } from './audit.mjs';
import { isValidEmail, normalizeEmail, validateTeachers } from './normalize.mjs';
import { buildPlan, loadPlan, savePlan } from './plan.mjs';
import { printPlanSummary, writeMarkdownReport } from './report.mjs';
import { interactiveLogin, openSiteSession } from './browser.mjs';
import { AhaAdapter } from './platforms/aha.mjs';
import { ArclcAdapter } from './platforms/arclc.mjs';
import { ensureInteractiveSession } from './session-check.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const command = process.argv[2];

if (!command || command === 'help' || command === '--help') {
  console.log(`Teacher Offboarding Automation\n\nCommands:\n  npm run validate -- --config config.json\n  npm run dry-run -- --config config.json\n  npm run login:aha -- --config config.json\n  npm run login:arclc -- --config config.json\n  npm run inspect -- --config config.json --platform <aha|arclc> --limit 5\n  npm run live-test -- --config config.json --platform <aha|arclc> --email <exact-email> --confirm "UNALIGN:<exact-email>"\n  npm run execute -- --config config.json --plan <file> --confirm <run-id> [--platform aha|arclc] [--start 0] [--limit 10]`);
  console.log('\nFor live-test, or inspect with --email, also pass --name "Full Name From Roster". Missing/mismatched names cannot authorize removal.');
  process.exit(0);
}

const config = await loadConfig(option('config', 'config.json'));

async function readAndValidate() {
  const rows = await readTeacherRows(config);
  return { rows, ...validateTeachers(rows, config) };
}

if (command === 'validate') {
  const result = await readAndValidate();
  console.log(`Rows read: ${result.rows.length}`);
  console.log(`Eligible: ${result.accepted.length}`);
  console.log(`Rejected/manual review: ${result.rejected.length}`);
  if (result.rejected.length) console.table(result.rejected.map(row => ({ row: row.rowNumber, reasons: row.reasons.join(', ') })));
} else if (command === 'dry-run') {
  const { accepted, rejected } = await readAndValidate();
  const plan = buildPlan(accepted, rejected, config);
  const planPath = await savePlan(plan, config.runtime.plansDir);
  const reportPath = await writeMarkdownReport(plan, config.runtime.reportsDir);
  printPlanSummary(plan);
  console.log(`\nPlan: ${planPath}`);
  console.log(`Report: ${reportPath}`);
  console.log(`To execute later: npm run execute -- --plan "${planPath}" --confirm "${plan.runId}"`);
} else if (command === 'login') {
  const site = option('site');
  if (!['aha', 'arclc'].includes(site)) throw new Error('Use --site aha or --site arclc');
  await interactiveLogin(site, config);
} else if (command === 'inspect') {
  const platform = option('platform');
  const limit = Number(option('limit', '5'));
  if (!['aha', 'arclc'].includes(platform)) throw new Error('Inspect requires --platform aha or --platform arclc');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('--limit must be an integer from 1 to 500');
  const email = normalizeEmail(option('email'));
  if (option('email') && !isValidEmail(email)) throw new Error('Invalid inspect --email');
  if (email && !option('name')?.trim()) throw new Error('Inspect by email requires --name from the source roster.');
  const accepted = email ? [{ email, fullName: option('name'), sourceRows: [] }] : (await readAndValidate()).accepted;
  const { context, page } = await openSiteSession(platform, config);
  const Adapter = platform === 'aha' ? AhaAdapter : ArclcAdapter;
  const adapter = new Adapter(config, page);
  try {
    const selected = accepted.slice(0, limit);
    if (platform === 'aha') {
      const results = await adapter.inspectMany(selected);
      for (const result of results) {
        console.log(`Source row(s) ${result.item.sourceRows.join(',')}: ${result.status} — ${result.detail}`);
      }
    } else {
      for (const teacher of selected) {
        const result = await adapter.inspect(teacher);
        console.log(`Source row(s) ${teacher.sourceRows.join(',')}: ${result.status} — ${result.detail}`);
      }
    }
  } finally {
    await context.close();
  }
} else if (command === 'live-test') {
  const platform = option('platform');
  const fullName=option('name');
  if(!fullName?.trim()) throw new Error('Live test requires --name with the teacher name from the approved source roster.');
  const email = normalizeEmail(option('email'));
  const confirmation = option('confirm');
  if (!['aha', 'arclc'].includes(platform)) throw new Error('Live test requires --platform aha or --platform arclc');
  if (!isValidEmail(email)) throw new Error('Live test requires a valid exact --email');
  if (confirmation !== `UNALIGN:${email}`) {
    throw new Error(`Confirmation mismatch. Pass --confirm "UNALIGN:${email}"`);
  }
  console.log(`Opening the saved ${platform.toUpperCase()} browser profile...`);
  const { context, page } = await openSiteSession(platform, config);
  console.log(`Browser opened. Starting exact-email preflight from: ${page.url()}`);
  const Adapter = platform === 'aha' ? AhaAdapter : ArclcAdapter;
  config.sites[platform].implementationStatus = 'ready';
  config.runtime.confirmDialog = async ({ type, message }) => {
    console.log(`\n${platform.toUpperCase()} native ${type} for ${email}:\n${message}`);
    if (!stdin.isTTY) return false;
    const prompt = readline.createInterface({ input: stdin, output: stdout });
    try {
      const answer = await prompt.question('If this confirms removal of this teacher affiliation, type YES to accept; otherwise Enter cancels: ');
      return answer.trim() === 'YES';
    } finally { prompt.close(); }
  };
  const adapter = new Adapter(config, page);
  const credentialFile = config.source.credentialsFile || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const canSync = credentialFile && await access(credentialFile).then(() => true, () => false);
  const sync = canSync ? record => appendAuditRows(config, [record]) : undefined;
  if (!canSync) console.log('Sheet audit credentials unavailable; this live test is recorded durably in reports/audit/events.jsonl.');
  try {
    if (!stdin.isTTY) throw new Error('Live test login verification requires an interactive terminal.');
    const loginPrompt = readline.createInterface({ input: stdin, output: stdout });
    try { await ensureInteractiveSession(platform, config, page, message => loginPrompt.question(message)); }
    finally { loginPrompt.close(); }
    const result = await runAuditedAction({ config, item: { email, fullName, platform, organization: config.sites[platform].organizationLabel }, runId: 'live-' + randomUUID(), sync, action: async () => {
      const before = await adapter.inspect({ email, fullName });
      console.log(`Preflight: ${before.status} — ${before.detail}`);
      if (before.status !== 'READY') return before;
      return adapter.unalign({ email, fullName });
    } });
    console.log(`Result: ${result.status} — ${result.detail}\nLocal audit: ${result.auditPath}`);
    if (!TERMINAL_RESULTS.has(result.status)) process.exitCode = 2;
  } finally {
    if (process.argv.includes('--keep-open') && stdin.isTTY && !page.isClosed()) {
      const prompt = readline.createInterface({ input: stdin, output: stdout });
      try { await prompt.question('Browser retained for inspection. Press Enter to close it: '); }
      finally { prompt.close(); }
    }
    await context.close();
  }
} else if (command === 'execute') {
  const planPath = option('plan');
  const confirmation = option('confirm');
  if (!planPath) throw new Error('Execution requires --plan /path/to/run.plan.json');
  const plan = await loadPlan(planPath);
  if (plan.schemaVersion !== 2) throw new Error('Regenerate the dry-run plan: schema 2 binds ARCLC actions to their organization.');
  if (confirmation !== plan.runId) {
    throw new Error(`Confirmation mismatch. Pass --confirm "${plan.runId}" after reviewing the dry-run report.`);
  }
  if (plan.spreadsheetId !== config.source.spreadsheetId) throw new Error('Plan spreadsheet does not match config.');
  if (plan.sheetName !== config.source.sheetName) throw new Error('Plan source tab does not match config.');
  const { accepted } = await readAndValidate();
  const current = new Map(accepted.map(item => [item.email, item]));
  const keys = new Set();
  for (const item of plan.items) {
    const teacher = current.get(item.email);
    const key = item.platform + ':' + item.email;
    if (!teacher || !['aha', 'arclc'].includes(item.platform) || item.action !== 'UNALIGN' || keys.has(key) ||
      !config.sites[item.platform].enabled || !(item.platform === 'aha' ? teacher.processAha : teacher.processArclc) ||
      (item.platform === 'arclc' && item.organization !== 'ALLCPR Inc.') ||
      (item.platform === 'aha' && item.organizationId !== config.sites.aha.organizationId)) throw new Error('Plan is stale, duplicated, or outside the current authorized source/scope. Regenerate dry-run.');
    keys.add(key);
  }
  await ensureAuditSheet(config);
  const platformFilter = option('platform');
  if (platformFilter && !['aha', 'arclc'].includes(platformFilter)) throw new Error('--platform must be aha or arclc');
  const start = Number(option('start', '0'));
  const limit = Number(option('limit', String(Math.min(10, config.safety.maxExecuteActions))));
  if (!Number.isInteger(start) || start < 0) throw new Error('--start must be a non-negative integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > config.safety.maxExecuteActions) {
    throw new Error(`--limit must be from 1 to ${config.safety.maxExecuteActions}`);
  }
  const eligibleItems = platformFilter ? plan.items.filter(item => item.platform === platformFilter) : plan.items;
  const items = eligibleItems.slice(start, start + limit);
  if (!items.length) throw new Error('The selected plan slice is empty.');

  let completed = 0;
  for (const platform of new Set(items.map(item => item.platform))) {
    const { context, page } = await openSiteSession(platform, config);
    const Adapter = platform === 'aha' ? AhaAdapter : ArclcAdapter;
    const adapter = new Adapter(config, page);
    try {
      adapter.assertReady();
      for (const item of items.filter(candidate => candidate.platform === platform)) {
        const result = await runAuditedAction({ config, item, runId: plan.runId,
          action: () => adapter.unalign(item), sync: record => appendAuditRows(config, [record]) });
        if (!TERMINAL_RESULTS.has(result.status)) throw new Error(`Batch stopped at ${item.email}: ${result.status}. ${result.detail}`);
        completed += 1;
      }
    } finally {
      await context.close();
    }
  }
  console.log(`Verified ${completed} selected action(s). Local and Sheet audits saved.`);
} else {
  throw new Error(`Unknown command: ${command}`);
}
