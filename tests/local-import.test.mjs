import test from 'node:test';
import assert from 'node:assert/strict';
import { importRoster, normalizeRoster } from '../src/local/import.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {importLimits,MIB} from '../src/local/limits.mjs';
import {largeRoster} from './large-roster-fixture.mjs';
import {pythonExecutable} from '../src/runtime.mjs';

test('50 MB CSV reaches extraction, one byte over fails, and configured file caps are enforced',async()=>{
  assert.equal(importLimits().maxFileBytes,50*MIB);
  for(const value of [0,-1,101,1.5,'50']) assert.throws(()=>importLimits({import:{maxFileMb:value}}));
  const bytes=largeRoster(50*MIB);
  const result=await importRoster({fileName:'large-synthetic.csv',bytes});
  assert.equal(result.accepted.length,1);assert.ok(result.sourceRowCount>1000);
  await assert.rejects(importRoster({fileName:'too-large.csv',bytes:Buffer.alloc(50*MIB+1)}),/50 MB/);
  await assert.rejects(importRoster({fileName:'custom.csv',bytes},{import:{maxFileMb:1}}),/1 MB/);
});

test('file size increase does not remove row, column or CSV field limits',async()=>{
  for(const text of ['Full Name,Email\n'+'Teacher,test@example.com\n'.repeat(10000),
    'Full Name,Email,'+'Other,'.repeat(100)+'\n', 'Full Name,Email,Notes\nTeacher,test@example.com,'+'x'.repeat(32769)]) {
    await assert.rejects(importRoster({fileName:'oversized-structure.csv',bytes:Buffer.from(text)}));
  }
});

test('XLSX larger than 8 MB with a large worksheet XML imports under the new bound',async()=>{
  const python=pythonExecutable();
  const script=[
    'import io, sys, zipfile',
    'from openpyxl import Workbook',
    'wb=Workbook(); ws=wb.active; ws.title="Teachers"',
    'ws.append(["Full Name","Email","Notes"])',
    'for n in range(350): ws.append(["Example Teacher","example@example.com","x"*30000])',
    'raw=io.BytesIO(); wb.save(raw); wb.close(); output=io.BytesIO()',
    'with zipfile.ZipFile(raw) as source, zipfile.ZipFile(output,"w",compression=zipfile.ZIP_STORED) as target:',
    '    for entry in source.infolist(): target.writestr(entry.filename,source.read(entry))',
    'sys.stdout.buffer.write(output.getvalue())'
  ].join('\n');
  const bytes=execFileSync(python,['-c',script],{maxBuffer:32*MIB});assert.ok(bytes.length>8*MIB);
  const result=await importRoster({fileName:'large-synthetic.xlsx',bytes});
  assert.equal(result.accepted.length,1);assert.equal(result.rejected.length,0);assert.equal(result.sourceRowCount,350);
});

test('local CSV import deduplicates email, ignores status and preserves source row numbers', async () => {
  const data = '\uFEFFFull Name,Email,Status\r\n"Example, Teacher",USER@example.com,Active\r\n"Example, Teacher",user@example.com,Departed\r\n';
  const bytes = Buffer.from(data), before = Buffer.from(bytes);
  const result = await importRoster({ fileName: 'departed.csv', bytes });
  assert.deepEqual(bytes, before);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.accepted[0].sourceRows, [2, 3]);
  assert.equal(result.duplicateRows, 1);
  assert.equal(result.source.sha256.length, 64);
});

test('ambiguous headers, identity formulas, invalid emails and same-email conflicts fail closed', () => {
  assert.throws(() => normalizeRoster([['Full Name','Email','Email Address']]), /Multiple/);
  assert.throws(() => normalizeRoster([['Other','Email']]), /first row/);
  const roster = normalizeRoster([['Full Name', 'Email'], ['One', 'a@example.com'], ['Two', 'a@example.com'], [{invalid:'FORMULA_OR_ERROR'}, 'b@example.com'], ['Good', 'b@example.com'], ['=D1','c@example.com'], ['No', 'not-email']]);
  assert.equal(roster.accepted.length, 0);
  assert.equal(roster.rejected.length, 5);
});

test('UTF16 CSV and Chinese headers are supported; malformed input is rejected', async () => {
  const bytes = Buffer.concat([Buffer.from([255,254]), Buffer.from('姓名,邮箱\r\n示例老师,test@example.com\r\n', 'utf16le')]);
  const result = await importRoster({fileName:'名单.csv',bytes});
  assert.equal(result.accepted[0].fullName, '示例老师');
  await assert.rejects(importRoster({fileName:'bad.csv',bytes:Buffer.from('Full Name,Email\n"unterminated,test@example.com')}));
  await assert.rejects(importRoster({fileName:'bad.xls',bytes:Buffer.from('anything')}), /supported/);
});

test('XLSX requires explicit multi-sheet selection and never trusts cached identity formula values', async () => {
  const python=pythonExecutable();
  const bytes=execFileSync(python,[fileURLToPath(new URL('./xlsx-fixture.py',import.meta.url))],{input:JSON.stringify([
    {name:'Teachers',rows:[['Full Name','Email'],['Example Teacher','test@example.com'],['Example Teacher','TEST@example.com']]},
    {name:'Formula identity',rows:[['Full Name','Email'],[{formula:'A3'},'formula@example.com']]}
  ])});
  const choose=await importRoster({fileName:'synthetic.xlsx',bytes});
  assert.equal(choose.needsSheet,true); assert.deepEqual(choose.sheetNames,['Teachers','Formula identity']);
  const valid=await importRoster({fileName:'synthetic.xlsx',bytes,sheetName:'Teachers'});
  assert.equal(valid.accepted.length,1); assert.equal(valid.duplicateRows,1);
  const formula=await importRoster({fileName:'synthetic.xlsx',bytes,sheetName:'Formula identity'});
  assert.equal(formula.accepted.length,0); assert.equal(formula.rejected.length,1);
  await assert.rejects(importRoster({fileName:'synthetic.xlsx',bytes,sheetName:'missing'}),/does not exist/);
});
