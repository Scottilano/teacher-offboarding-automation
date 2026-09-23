import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkSession, openLoginEntry } from '../../src/session-check.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('data/ms-playwright');
const { chromium } = await import('playwright');
const config = { sites: { aha: { organizationId: '32238' }, arclc: { loginUrl: 'https://www.redcrosslearningcenter.org/login' } } };

test('browser session probes do not trust stale tables after first-party authentication failure, on both sites', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const platform of ['aha', 'arclc']) {
      const context = await browser.newContext();
      let expired = false;
      const html = platform === 'aha'
        ? '<table aria-label="Manage Instructors"><tr><th>Instructor</th></tr></table>'
        : '<table role="grid"><tr><th>Instructor</th></tr></table>';
      await context.route('**/*', route => route.fulfill({
        status: expired ? 401 : 200, contentType: 'text/html', body: html
      }));
      const page = await context.newPage();
      assert.equal((await checkSession(platform, config, page)).status, 'READY');
      expired = true; // Existing page still displays the identical table.
      assert.equal((await checkSession(platform, config, page)).status, 'LOGIN_REQUIRED');
      await context.close();
    }
  } finally { await browser.close(); }
});

test('browser AHA login entry opens the password form without entering any credentials', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({
      contentType: 'text/html',
      body: new URL(route.request().url()).pathname === '/test-login'
        ? '<label>Password<input type="password"></label>'
        : '<button onclick="location.href=\'/test-login\'">Sign In | Sign Up</button>'
    }));
    const page = await context.newPage();
    await openLoginEntry('aha', config, page);
    await page.getByLabel('Password').waitFor({ state: 'visible' });
    assert.equal(await page.getByLabel('Password').inputValue(), '');
  } finally { await browser.close(); }
});
