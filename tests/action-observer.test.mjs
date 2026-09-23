import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeAction } from '../src/action-observer.mjs';

test('native confirm is captured and accepted only by explicit choice', async () => {
  for (const approved of [true, false]) {
    const page = new EventEmitter();
    const decisions = [];
    const observer = observeAction(page, { confirmDialog: async event => { assert.equal(event.message, 'Remove selected affiliation?'); return approved; } });
    page.emit('dialog', { type: () => 'confirm', message: () => 'Remove selected affiliation?', accept: async () => decisions.push('accept'), dismiss: async () => decisions.push('dismiss') });
    await observer.settle();
    assert.deepEqual(decisions, [approved ? 'accept' : 'dismiss']);
    assert.equal(observer.blocked, !approved);
    assert.equal(observer.events[0].kind, 'native-dialog');
    await observer.stop();
    assert.equal(page.listenerCount('dialog'), 0);
  }
});

test('unknown batch confirm and native errors are recorded and dismissed', async () => {
  for (const type of ['confirm', 'alert', 'prompt']) {
    const page = new EventEmitter();
    let dismissed = false;
    const observer = observeAction(page, { allowedConfirmMessages: ['Reviewed confirmation'] });
    page.emit('dialog', { type: () => type, message: () => 'Unexpected text', accept: async () => { throw new Error('must not accept'); }, dismiss: async () => { dismissed = true; } });
    await observer.settle();
    assert.equal(dismissed, true);
    assert.equal(observer.blocked, true);
    await observer.stop();
  }
});

test('network observation persists until stopped and strips query secrets', async () => {
  const page = new EventEmitter();
  const observer = observeAction(page);
  page.emit('request', { method: () => 'POST', url: () => 'https://example.com/aura?token=secret', resourceType: () => 'xhr' });
  page.emit('response', { status: () => 200, url: () => 'https://example.com/aura?token=secret' });
  assert.equal(JSON.stringify(observer.events).includes('secret'), false);
  assert.equal(observer.events.length, 2);
  await observer.stop();
});
