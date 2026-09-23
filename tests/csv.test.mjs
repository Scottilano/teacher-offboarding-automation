import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';

test('parses quoted commas, escaped quotes and CRLF', () => {
  const rows = parseCsv('"Name","Email"\r\n"Doe, Jane","jane@example.com"\r\n"A ""quoted"" name","a@example.com"\r\n');
  assert.deepEqual(rows, [
    ['Name', 'Email'],
    ['Doe, Jane', 'jane@example.com'],
    ['A "quoted" name', 'a@example.com']
  ]);
});
