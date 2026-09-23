import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ensureInteractiveSession } from './session-check.mjs';

export async function openSiteSession(siteName, config) {
  const profileDirectory = path.join(config.browser.profileRoot, siteName);
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(config.runtime.baseDir, 'data', 'ms-playwright');
  const { chromium } = await import('playwright');
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless: config.browser.headless,
    slowMo: config.browser.slowMoMs,
    viewport: { width: 1440, height: 960 }
  });
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  return { context, page, profileDirectory };
}

export async function interactiveLogin(siteName, config) {
  const site = config.sites[siteName];
  if (!site) throw new Error(`Unknown site: ${siteName}`);
  const { context, page, profileDirectory } = await openSiteSession(siteName, config);
  console.log(`\nComplete sign-in/MFA in the browser. Profile: ${profileDirectory}`);
  const prompt = readline.createInterface({ input, output });
  try { await ensureInteractiveSession(siteName, config, page, message => prompt.question(message)); }
  finally { prompt.close(); await context.close(); }
  console.log('Login session saved locally. Treat the profile directory as a password.');
}
