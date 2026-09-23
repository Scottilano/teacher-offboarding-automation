import { google } from 'googleapis';
import { access } from 'node:fs/promises';

const AUDIT_HEADERS = [
  'Run ID', 'Timestamp', 'Source Rows', 'Full Name', 'Email', 'Achievement(s)',
  'Platform', 'Action', 'Result', 'Detail'
];

function quoteSheetName(name) {
  return `'${String(name).replaceAll("'", "''")}'`;
}

async function sheetsClient(config) {
  const keyFile = config.source.credentialsFile || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) {
    throw new Error('Google credentials missing. Set source.credentialsFile or GOOGLE_APPLICATION_CREDENTIALS.');
  }
  await access(keyFile).catch(() => {
    throw new Error(`Google credentials file unavailable: ${keyFile}. See GOOGLE-SHEETS-SETUP.md. No website action has been started by this Sheets request.`);
  });
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

export async function readTeacherRows(config) {
  const sheets = await sheetsClient(config);
  const range = `${quoteSheetName(config.source.sheetName)}!${config.source.range || 'A1:Z5000'}`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.source.spreadsheetId,
    range
  });
  const values = response.data.values || [];
  if (!values.length) throw new Error(`No data found in ${range}`);

  const headers = values[0].map(value => String(value).trim());
  const index = Object.fromEntries(headers.map((header, i) => [header, i]));
  const mapping = config.source.headers;
  for (const field of ['fullName', 'email']) {
    if (index[mapping[field]] === undefined) {
      throw new Error(`Required header not found: ${mapping[field]}`);
    }
  }

  const columnIndex = value => {
    if (Number.isInteger(value)) return value - 1;
    if (!/^[A-Z]+$/i.test(String(value || ''))) return undefined;
    return [...String(value).toUpperCase()]
      .reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
  };
  const optionalValue = (cells, field) => {
    const header = mapping[field];
    if (header && index[header] !== undefined) return cells[index[header]] ?? '';
    const resolvedIndex = columnIndex(config.source.columns?.[field]);
    return resolvedIndex === undefined ? undefined : (cells[resolvedIndex] ?? '');
  };

  return values.slice(1).map((cells, offset) => ({
    rowNumber: offset + 2,
    fullName: cells[index[mapping.fullName]] ?? '',
    email: cells[index[mapping.email]] ?? '',
    achievement: optionalValue(cells, 'achievement'),
    upgradeType: optionalValue(cells, 'upgradeType'),
    status: optionalValue(cells, 'status'),
    approved: optionalValue(cells, 'approved'),
    processAha: optionalValue(cells, 'processAha'),
    processArclc: optionalValue(cells, 'processArclc')
  })).filter(row => [row.fullName, row.email, row.achievement, row.status]
    .some(value => String(value ?? '').trim()));
}

export async function ensureAuditSheet(config) {
  const sheets = await sheetsClient(config);
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: config.source.spreadsheetId,
    fields: 'sheets.properties.title'
  });
  const exists = metadata.data.sheets?.some(sheet => sheet.properties?.title === config.audit.sheetName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.source.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: config.audit.sheetName } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.source.spreadsheetId,
      range: `${quoteSheetName(config.audit.sheetName)}!A1:J1`,
      valueInputOption: 'RAW',
      requestBody: { values: [AUDIT_HEADERS] }
    });
  }
  return sheets;
}

export async function appendAuditRows(config, records) {
  if (!records.length) return;
  const sheets = await ensureAuditSheet(config);
  const values = records.map(record => [
    record.runId,
    record.timestamp,
    record.sourceRows?.join(',') || record.rowNumber,
    record.fullName,
    record.email,
    record.achievements?.join('; ') || '',
    record.platform,
    'UNALIGN',
    record.result,
    record.detail || ''
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.source.spreadsheetId,
    range: `${quoteSheetName(config.audit.sheetName)}!A:J`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
}
