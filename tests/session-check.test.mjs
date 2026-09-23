import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkSession, ensureInteractiveSession, isAuthFailureResponse, openLoginEntry } from '../src/session-check.mjs';
import { observeAction } from '../src/action-observer.mjs';

const config = { sites: { aha: { organizationId: '32238' }, arclc: { loginUrl: 'https://www.redcrosslearningcenter.org/login' } } };
function pageFixture({ ready = true, expired = false, rejected = false } = {}) {
  const page = new EventEmitter();
  let address = 'https://atlas.heart.org/manage-Instructor';
  const navigations = [], clicks = [];
  const node = (kind, name = '') => ({
    first() { return this; }, filter() { return this; },
    count: async () => kind === 'table' ? (ready ? 1 : 0) : kind === 'rows' ? 1 : kind === 'password' ? 0 : !ready ? 1 : 0,
    isVisible: async () => kind === 'table' ? ready : !ready,
    getByRole: () => node('rows'),
    allTextContents: async () => expired ? ['Your session has expired. Please sign in again.'] : [],
    click: async () => { clicks.push(name); }
  });
  page.goto = async url => {
    navigations.push(url);
    address = ready ? url : new URL(url).origin + '/';
    if (rejected) page.emit('response', { status: () => 401, url: () => url });
  };
  page.url = () => address;
  page.isClosed = () => false;
  page.waitForTimeout = async () => {};
  page.getByRole = (role, opts = {}) => node(['grid','table'].includes(role) ? 'table' : 'button', String(opts.name));
  page.locator = selector => node(selector.includes('password') ? 'password' : 'alerts');
  return { page, navigations, clicks };
}

test('both platforms force fresh protected navigation even if a stale table is already visible', async () => {
  for (const platform of ['aha', 'arclc']) {
    const f = pageFixture();
    const result = await checkSession(platform, config, f.page);
    assert.equal(result.status, 'READY');
    assert.equal(f.navigations.length, 1);
    assert.match(f.navigations[0], /manage-[Ii]nstructor/);
    assert.equal(f.page.listenerCount('response'), 0);
    assert.equal(f.page.listenerCount('dialog'), 0);
  }
});

test('fresh redirect to login, an expiry modal or first-party 401 cannot pass as authenticated', async () => {
  for (const options of [{ ready: false }, { expired: true }, { rejected: true }]) {
    const f = pageFixture(options);
    assert.equal((await checkSession('aha', config, f.page)).status, 'LOGIN_REQUIRED');
  }
});

test('AHA opens the observed Sign In entry; ARC opens its configured official login page', async () => {
  const aha = pageFixture({ ready: false });
  await openLoginEntry('aha', config, aha.page);
  assert.ok(aha.clicks.some(x => x.includes('Sign In')));
  const arc = pageFixture({ ready: false });
  await openLoginEntry('arclc', config, arc.page);
  assert.deepEqual(arc.navigations, [config.sites.arclc.loginUrl]);
});

test('Enter and CHECK are not authentication proof; cancellation never reaches the next step', async () => {
  let checks = 0, questions = 0;
  const answers = ['', 'CHECK', 'CANCEL'];
  await assert.rejects(ensureInteractiveSession('aha', config, { isClosed: () => false },
    async () => { questions++; return answers.shift(); },
    async () => { checks++; return { status: 'LOGIN_REQUIRED', detail: 'test expired' }; }), /cancelled/);
  assert.equal(checks, 2);
  assert.equal(questions, 3);
});

test('interactive login proceeds only after a fresh authenticated check', async () => {
  let checks = 0;
  await ensureInteractiveSession('aha', config, { isClosed: () => false }, async () => 'CHECK',
    async () => ({ status: ++checks === 2 ? 'READY' : 'LOGIN_REQUIRED', detail: 'test' }));
  assert.equal(checks, 2);
});

test('post-submit session loss is observed without approving an expiry confirm or accepting third-party noise', async () => {
  const page = new EventEmitter();
  let approved = false, dismissed = false;
  const observer = observeAction(page, { platform: 'aha', confirmDialog: async () => { approved = true; return true; } });
  page.emit('response', { status: () => 401, url: () => 'https://analytics.example.com/track' });
  assert.equal(observer.sessionExpired, false);
  page.emit('dialog', { type: () => 'confirm', message: () => 'Your session has expired, sign in again.',
    accept: async () => {}, dismiss: async () => { dismissed = true; } });
  await observer.settle();
  assert.equal(observer.sessionExpired, true);
  assert.equal(approved, false);
  assert.equal(dismissed, true);
  await observer.stop();
  assert.equal(isAuthFailureResponse('arclc', 403, 'https://www.redcrosslearningcenter.org/s/manage-instructors'), true);
});
