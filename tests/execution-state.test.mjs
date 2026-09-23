import test from 'node:test';
import assert from 'node:assert/strict';
import { executionState } from '../ui/execution-state.js';
const state = { busy: false, browsers: ['arclc'], sites: { arclc: { ready: true } } };
const job = statuses => ({ items: statuses.map((status, i) => ({ fullName: `Teacher ${i + 1}`, platform: 'arclc', status })) });

test('after a verified batch the next batch explicitly requires renewed approval', () => {
  const j = job(['REMOVED', 'ABSENT_VERIFIED', 'REMOVED', 'PENDING']);
  assert.match(executionState(j, state, false).reason, /authorization box again/);
  assert.equal(executionState(j, state, false).disabled, true);
  assert.equal(executionState(j, state, true).disabled, false);
});

test('non-Instructor/manual review visibly blocks continuation instead of silent failure', () => {
  const j = job(['ABSENT_VERIFIED', 'ABSENT_VERIFIED', 'MANUAL_REVIEW', 'PENDING']);
  for (const approved of [true, false]) {
    const result = executionState(j, state, approved);
    assert.equal(result.disabled, true);
    assert.match(result.reason, /Teacher 3/);
    assert.match(result.reason, /Other roles are never automatically removed/);
  }
});

test('missing browser, locked platform, complete task and busy state each explain why execution is unavailable', () => {
  assert.match(executionState(job(['PENDING']), { ...state, browsers: [] }, true).reason, /sign-in/);
  assert.match(executionState(job(['PENDING']), { ...state, sites: {} }, true).reason, /awaiting acceptance/);
  assert.match(executionState(job(['REMOVED']), state, true).reason, /All platform/);
  assert.match(executionState(job(['PENDING']), { ...state, busy: true }, true).reason, /still running/);
});

test('approved deferred items do not block other teachers and never count as complete', () => {
  assert.equal(executionState(job(['DEFERRED','PENDING']),state,true).disabled,false);
  const result=executionState(job(['DEFERRED','REMOVED']),state,true);
  assert.equal(result.disabled,true); assert.match(result.reason,/not necessarily complete/);
});
