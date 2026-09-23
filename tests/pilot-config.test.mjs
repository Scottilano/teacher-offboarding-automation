import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { loadConfig } from '../src/config.mjs';
import { observeAction } from '../src/action-observer.mjs';

test('validated ARCLC confirm is accepted exactly; changed text and alert fail closed', async () => {
  const message = 'Remove this synthetic instructor affiliation?';
  const config = {sites:{arclc:{allowedConfirmMessages:[message]}}};
  for (const [type, text, expected] of [['confirm', message, 'accept'], ['confirm', message + ' Changed', 'dismiss'], ['alert', message, 'dismiss']]) {
    const page = new EventEmitter();
    let decision;
    const observer = observeAction(page, config.sites.arclc);
    page.emit('dialog', { type: () => type, message: () => text, accept: async () => { decision = 'accept'; }, dismiss: async () => { decision = 'dismiss'; } });
    await observer.settle();
    assert.equal(decision, expected);
    assert.equal(observer.blocked, expected !== 'accept');
    await observer.stop();
  }
});

test('explicit Google credentials environment overrides default configured file', async () => {
  const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/offboarding-test-key-not-a-real-secret.json';
    const config = await loadConfig(new URL('../config.example.json', import.meta.url).pathname, {localOnly:true});
    assert.equal(config.source.credentialsFile, process.env.GOOGLE_APPLICATION_CREDENTIALS);
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
  }
});
