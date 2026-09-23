const origins = { aha: 'https://atlas.heart.org', arclc: 'https://www.redcrosslearningcenter.org' };
const paths = { aha: '/manage-Instructor', arclc: '/s/manage-instructors' };
const expiredText = /session.{0,50}(expired|invalid|timed out)|(?:log|sign)[ -]?in.{0,35}(again|required)|please.{0,25}(?:log|sign)[ -]?in|会话.{0,10}(失效|过期)|重新登录/i;
export const isSessionExpiryText = text => expiredText.test(String(text || ''));

export function isAuthFailureResponse(platform, status, address) {
  try { return [401, 403].includes(status) && new URL(address).origin === origins[platform]; }
  catch { return false; }
}

export async function visibleSessionProblem(page) {
  const texts = await page.locator('[role="alert"], [role="dialog"], [role="alertdialog"]')
    .filter({ visible: true }).allTextContents();
  return texts.some(isSessionExpiryText);
}

// Navigate using the site's own login entry. Never read/store credentials or
// dismiss MFA/CAPTCHA; the operator completes those in the browser.
export async function openLoginEntry(platform, config, page) {
  if (!origins[platform]) throw new Error('Unknown login platform.');
  await page.goto(platform === 'aha' ? origins.aha + '/' : config.sites.arclc.loginUrl,
    { waitUntil: 'domcontentloaded' });
  if (platform !== 'aha') return;
  if (new URL(page.url()).origin !== origins.aha) return; // Already redirected to SSO.
  const signIn = page.getByRole('button', { name: /Sign In\s*\|\s*Sign Up/i });
  try {
    if (!await signIn.first().isVisible()) {
      const toggle = page.getByRole('button', { name: 'Toggle navigation', exact: true });
      if (await toggle.isVisible()) await toggle.click();
    }
    await signIn.first().click({ timeout: 10000 });
  } catch {
    // Keep the page available for manual login if the entry's design changed.
  }
}

// Fresh protected navigation, not the existence of an old browser window/table,
// is required on every entry and before every local job item.
export async function checkSession(platform, config, page, { openLogin = false, timeoutMs = 12000 } = {}) {
  if (!origins[platform]) throw new Error('Unknown login platform.');
  let authFailure = false;
  const dialogTasks = [];
  const onResponse = response => {
    if (isAuthFailureResponse(platform, response.status(), response.url())) authFailure = true;
  };
  const onDialog = dialog => {
    // This probe never submits anything. An unexpected native dialog is not
    // evidence of a valid session and must not hang the read-only navigation.
    authFailure = true;
    dialogTasks.push(dialog.dismiss().catch(() => {}));
  };
  page.on('response', onResponse);
  page.on('dialog', onDialog);
  let result;
  try {
    const target = new URL(paths[platform], origins[platform]);
    if (platform === 'aha') target.search = new URLSearchParams({
      orgId: String(config.sites.aha.organizationId), roleId: '17', roleName: 'INSTRUCTOR',
      expiryStatus: 'ALL', applyTsFilter: 'true'
    }).toString();
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deadline = Date.now() + timeoutMs;
    let stable = 0;
    while (Date.now() < deadline) {
      const url = new URL(page.url());
      const table = platform === 'aha' ? page.getByRole('table', { name: 'Manage Instructors', exact: true }) : page.getByRole('grid');
      const problem = authFailure || await visibleSessionProblem(page);
      if (problem) {
        result = { status: 'LOGIN_REQUIRED', detail: 'The site reports an expired session or restricted access. Sign in again and verify company permissions.' };
        break;
      }
      const ready = url.origin === origins[platform] && url.pathname === paths[platform] &&
        await table.count() === 1 && await table.isVisible() && await table.getByRole('row').count() > 0;
      stable = ready ? stable + 1 : 0;
      if (stable >= 4) {
        result = { status: 'READY', detail: 'Session verified on a freshly loaded protected page. Company, role and teacher will still be checked before each action.' };
        break;
      }
      const password = page.locator('input[type="password"]').filter({ visible: true });
      const signIn = page.getByRole('button', { name: /Sign In\s*\|\s*Sign Up/i }).filter({ visible: true });
      if (await password.count() || await signIn.count()) {
        result = { status: 'LOGIN_REQUIRED', detail: 'Not signed in, or the previous session expired. Sign in through the automated browser.' };
        break;
      }
      await page.waitForTimeout(500);
    }
    result ||= { status: 'SESSION_UNVERIFIED', detail: 'Session not verified: the protected page is not ready. Finish signing in; if this persists, check your network and company permissions.' };
  } catch {
    result = { status: 'SESSION_UNVERIFIED', detail: 'Session check failed (closed page, network error or navigation failure). No removal was submitted.' };
  } finally {
    page.off('response', onResponse);
    page.off('dialog', onDialog);
    await Promise.all(dialogTasks);
  }
  if (result.status !== 'READY' && openLogin && !page.isClosed()) {
    await openLoginEntry(platform, config, page).catch(() => {});
  }
  return { ...result, checkedAt: new Date().toISOString() };
}

export async function ensureInteractiveSession(platform, config, page, ask, check = checkSession) {
  for (;;) {
    console.log('Refreshing and checking ' + platform.toUpperCase() + ' sign-in status...');
    const result = await check(platform, config, page, { openLogin: true });
    if (result.status === 'READY') {
      console.log('Session verified; continuing with read-only preflight.');
      return;
    }
    console.log(result.detail + ' The sign-in page was requested. Enter passwords and MFA only in the browser.');
    for (;;) {
      const answer = (await ask('After signing in, type CHECK to verify again, or CANCEL to exit (Enter alone will not continue): ')).trim();
      if (answer === 'CANCEL') throw new Error('Session check cancelled by the user. No removal submitted.');
      if (answer === 'CHECK') break;
      console.log('Recheck not confirmed; removal will not proceed.');
    }
    if (page.isClosed()) throw new Error('The sign-in window was closed. No removal submitted.');
    // Even CHECK is only permission to re-check, never proof of login.
  }
}
