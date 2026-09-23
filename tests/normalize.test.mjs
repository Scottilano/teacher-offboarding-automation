import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, validateTeachers } from '../src/normalize.mjs';

const config = { eligibility: { allowedStatuses: [], requireApprovedColumn: false } };

test('normalizes email safely', () => {
  assert.equal(normalizeEmail('  Teacher@Example.COM '), 'teacher@example.com');
});

test('accepts an approved and complete teacher', () => {
  const result = validateTeachers([{
    rowNumber: 2,
    fullName: ' Jane   Smith ',
    email: 'Jane@Example.com',
    achievement: ' BLS ',
    status: 'Departed',
    processAha: 'TRUE',
    processArclc: 'TRUE'
  }], config);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].email, 'jane@example.com');
  assert.equal(result.accepted[0].fullName, 'Jane Smith');
});

test('rejects invalid or unselected rows and groups duplicate email rows', () => {
  const result = validateTeachers([
    { rowNumber: 2, fullName: 'A', email: 'bad', achievement: 'BLS', status: 'Blocked' },
    { rowNumber: 3, fullName: 'B', email: 'b@example.com', achievement: 'BLS', status: 'Departed' },
    { rowNumber: 4, fullName: 'B', email: 'B@example.com', achievement: 'FA', status: 'Departed' }
  ], config);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.rejected[0].reasons, ['INVALID_EMAIL']);
  assert.deepEqual(result.accepted[0].sourceRows, [3, 4]);
  assert.deepEqual(result.accepted[0].achievements, ['BLS', 'FA']);
});

test('ignores status when allowedStatuses is empty', () => {
  const result = validateTeachers([
    { rowNumber: 2, fullName: 'A', email: 'a@example.com', status: 'Blocked' },
    { rowNumber: 3, fullName: 'B', email: 'b@example.com', status: '' }
  ], config);
  assert.equal(result.accepted.length, 2);
});

test('can opt into status filtering later', () => {
  const filteredConfig = { eligibility: { allowedStatuses: ['Departed'], requireApprovedColumn: false } };
  const result = validateTeachers([
    { rowNumber: 2, fullName: 'A', email: 'a@example.com', status: 'Blocked' }
  ], filteredConfig);
  assert.deepEqual(result.rejected[0].reasons, ['STATUS_NOT_SELECTED']);
});
