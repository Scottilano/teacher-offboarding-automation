import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normalizeEmail, normalizeText, isValidEmail } from '../normalize.mjs';
import {importLimits} from './limits.mjs';
import {pythonExecutable} from '../runtime.mjs';

export const MAX_FILE_BYTES = importLimits().maxFileBytes;
const aliases = {
  fullName: ['fullname', 'name', 'teachername', 'instructorname', '姓名', '教师姓名', '老师姓名'],
  email: ['email', 'emailaddress', '邮箱', '电子邮箱', '电子邮件'],
  achievement: ['achievement:achievementname', 'achievement', 'classname', '课程名称']
};
const headerKey = text => String(text ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_\-]+/g, '');
const invalidCell = value => value && typeof value === 'object';

export function normalizeRoster(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('The roster is empty.');
  const header = rows[0].map(headerKey);
  const columns = {};
  for (const [field, names] of Object.entries(aliases)) {
    const found = header.flatMap((value, i) => names.includes(value) ? [i] : []);
    if (found.length > 1) throw new Error(`Multiple ${field} columns were found. Keep one unambiguous column.`);
    if (field !== 'achievement' && !found.length) throw new Error('The first row must contain Full Name and Email columns.');
    columns[field] = found[0];
  }
  const accepted = [], rejected = [], grouped = new Map();
  let sourceRowCount = 0;
  const poisonedEmails = new Set();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every(value => value === '' || value === null || value === undefined)) continue;
    sourceRowCount++;
    const nameCell = row[columns.fullName], emailCell = row[columns.email];
    const fullName = invalidCell(nameCell) ? '' : normalizeText(nameCell);
    const email = invalidCell(emailCell) ? '' : normalizeEmail(emailCell);
    const reasons = [];
    if (invalidCell(nameCell) || invalidCell(emailCell) || /^\s*=/.test(String(nameCell || '')) || /^\s*=/.test(String(emailCell || ''))) reasons.push('Name or email contains a formula or error; paste plain text values first');
    if (!fullName) reasons.push('Missing full name');
    if (!isValidEmail(email)) reasons.push('Missing or invalid email');
    if (fullName.length > 200 || email.length > 254 || /[\x00-\x1f\x7f]/.test(String(nameCell || '') + String(emailCell || ''))) reasons.push('Name or email is too long or contains invalid characters');
    if (reasons.length) {
      rejected.push({ sourceRows: [i + 1], fullName, email, reasons });
      if (isValidEmail(email)) poisonedEmails.add(email);
      continue;
    }
    const item = grouped.get(email) || { fullName, email, sourceRows: [], achievements: [], names: new Set() };
    item.sourceRows.push(i + 1);
    item.names.add(fullName.toLowerCase());
    const achievementCell = row[columns.achievement];
    const achievement = invalidCell(achievementCell) ? '' : normalizeText(achievementCell);
    if (achievement && !item.achievements.includes(achievement)) item.achievements.push(achievement);
    grouped.set(email, item);
  }
  for (const item of grouped.values()) {
    const conflict = item.names.size !== 1 || poisonedEmails.has(item.email);
    delete item.names;
    if (conflict) rejected.push({ ...item, reasons: ['The same email has conflicting names or invalid records; review the source file'] });
    else accepted.push(item);
  }
  return { accepted, rejected, sourceRowCount, duplicateRows: accepted.reduce((n, i) => n + i.sourceRows.length - 1, 0) };
}

export function extractInput(bytes, extension, sheetName, pythonPath, limits = importLimits()) {
  const python = pythonPath || pythonExecutable();
  return new Promise((resolve, reject) => {
    const args = [fileURLToPath(new URL('./read-input.py', import.meta.url)), extension, sheetName ?? '', String(limits.maxFileBytes)];
    const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0, tooLarge = false;
    const timer = setTimeout(() => child.kill(), limits.timeoutMs);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > limits.maxExtractedBytes) { tooLarge = true; child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('Roster reader is unavailable. Check OFFBOARDING_PYTHON or your local Python installation.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (tooLarge) return reject(new Error('Extracted data exceeds the size limit. Use a smaller roster.'));
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reject(new Error('File reading failed or timed out. Export the roster again.')); }
      if (code !== 0 || data.error) reject(new Error(data.error || 'Unable to read the file.'));
      else resolve(data);
    });
    child.stdin.end(bytes);
  });
}

export async function importRoster({ fileName, bytes, sheetName }, config = {}) {
  const limits = importLimits(config);
  if (typeof fileName !== 'string' || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limits.maxFileBytes) throw new Error(`Select a nonempty roster file no larger than ${limits.maxFileMb} MB.`);
  const extension = path.extname(fileName).toLowerCase();
  if (!['.csv', '.xlsx'].includes(extension)) throw new Error('Only .csv and .xlsx files are supported.');
  if (sheetName !== undefined && (typeof sheetName !== 'string' || sheetName.length > 100)) throw new Error('Invalid worksheet name.');
  const data = await extractInput(bytes, extension, sheetName, undefined, limits);
  if (data.needsSheet) return { needsSheet: true, sheetNames: data.sheetNames };
  return {
    source: { fileName: path.basename(fileName).slice(0, 200), sha256: createHash('sha256').update(bytes).digest('hex'), sheetName: data.sheetName, importedAt: new Date().toISOString() },
    ...normalizeRoster(data.rows)
  };
}
