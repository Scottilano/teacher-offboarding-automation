import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadConfig(configPath = 'config.json', { localOnly = false } = {}) {
  const absolutePath = path.resolve(configPath);
  await access(absolutePath).catch(() => {
    throw new Error(`Config not found: ${absolutePath}. Copy config.example.json to config.json first.`);
  });

  const config = JSON.parse(await readFile(absolutePath, 'utf8'));
  const baseDir = path.dirname(absolutePath);

  for (const required of (localOnly ? ['safety', 'browser', 'sites'] : ['source', 'audit', 'safety', 'browser', 'sites'])) {
    if (!config[required]) throw new Error(`Missing config section: ${required}`);
  }
  config.eligibility ||= { allowedStatuses: [], requireApprovedColumn: false };
  config.source ||= {};
  if (!localOnly && (!config.source.spreadsheetId || config.source.spreadsheetId.startsWith('PASTE_'))) {
    throw new Error('Set source.spreadsheetId in config.json.');
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    config.source.credentialsFile = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  } else if (config.source.credentialsFile) {
    config.source.credentialsFile = path.resolve(baseDir, config.source.credentialsFile);
  }
  config.browser.profileRoot = path.resolve(baseDir, config.browser.profileRoot);
  config.runtime = {
    baseDir,
    plansDir: path.resolve(baseDir, 'plans'),
    reportsDir: path.resolve(baseDir, 'reports')
  };
  config.runtimeCredentials = {
    arclc: {
      username: process.env.ARCLC_USERNAME || '',
      password: process.env.ARCLC_PASSWORD || ''
    },
    aha: {
      username: process.env.AHA_USERNAME || '',
      password: process.env.AHA_PASSWORD || ''
    }
  };
  return config;
}
