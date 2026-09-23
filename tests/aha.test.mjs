import test from 'node:test';
import assert from 'node:assert/strict';
import { AhaAdapter, assertAhaScope, ahaInstructorUrl, classifyAhaTeacher, ahaScopeSummary } from '../src/platforms/aha.mjs';

const email = 'target@example.com';
const site = { organizationId: '32238', implementationStatus: 'ready', coverageVerified: true };
const row = (statuses = ['', '']) => ({ email, fullName: 'Test Teacher', organization: 'ALLCPR',
  disciplines: statuses.map((status, i) => ({ name: ['BLS', 'Heartsaver'][i], status, hasActiveSince: true })) });
function adapterFor(views, overrides = {}) {
  let url;
  const adapter = new AhaAdapter({ sites: { aha: { ...site, ...overrides } } }, { url: () => url });
  adapter.searchExactRows = async (target, status = 'ALL') => {
    url = ahaInstructorUrl(target, '32238', status);
    return views[status] || [];
  };
  return adapter;
}

test('AHA scope requires unique company/Instructor/filter parameters and explicit ALL coverage', () => {
  const valid = ahaInstructorUrl(email, '32238');
  assert.doesNotThrow(() => assertAhaScope(valid, site, { requireCoverage: true }));
  for (const url of [valid.replace('atlas.heart.org', 'example.com'), valid.replace('32238', '999'),
    valid.replace('roleId=17', 'roleId=18'), valid.replace('INSTRUCTOR', 'ADMINISTRATOR'),
    valid + '&orgId=999', valid + '&discipline=BLS', valid.replace('applyTsFilter=true', 'applyTsFilter=false')]) {
    assert.throws(() => assertAhaScope(url, site), /scope/);
  }
  for (const url of [valid.replace('expiryStatus=ALL', 'expiryStatus=ACTIVE'), valid.replace('&expiryStatus=ALL', '')]) {
    assert.throws(() => assertAhaScope(url, site, { requireCoverage: true }), /coverage/);
  }
  assert.throws(() => assertAhaScope(valid, { ...site, coverageVerified: false }, { requireCoverage: true }), /coverage/);
});

test('historical Not Aligned rows are not removable; partial and expired alignments still are', () => {
  assert.equal(classifyAhaTeacher([row(['Not Aligned', 'Not Aligned'])], email).status, 'UNALIGNED_IN_VIEW');
  assert.deepEqual(classifyAhaTeacher([row(['Not Aligned', ''])], email).disciplines, ['Heartsaver']);
  assert.deepEqual(classifyAhaTeacher([row(['Expired', 'Not Aligned'])], email).disciplines, ['BLS']);
  assert.equal(classifyAhaTeacher([row()], email.toUpperCase()).status, 'READY');
  assert.equal(classifyAhaTeacher([row()], 'x' + email).status, 'ABSENT_IN_VIEW');
});

test('duplicates, other organizations and unknown/empty discipline states require manual review', () => {
  const malformed = [
    { ...row(), organization: 'Other Company' }, { ...row(), disciplines: [] },
    { ...row(), disciplines: [{ name: 'BLS', status: 'Pending', hasActiveSince: true }] },
    { ...row(), disciplines: [{ name: 'Unknown', status: '', hasActiveSince: true }] },
    { ...row(), disciplines: [{ name: 'BLS', status: '', hasActiveSince: false }] },
    { ...row(), disciplines: [row().disciplines[0], row().disciplines[0]] }
  ];
  for (const bad of malformed) assert.equal(classifyAhaTeacher([bad], email).status, 'MANUAL_REVIEW');
  assert.equal(classifyAhaTeacher([row(), row()], email).status, 'MANUAL_REVIEW');
});

test('absence requires ALL, ACTIVE and EXPIRED; retained historical row is valid evidence', async () => {
  for (const views of [{}, { ALL: [row(['Not Aligned', 'Not Aligned'])] }]) {
    const result = await adapterFor(views).verifyAbsent(email, ['BLS', 'Heartsaver']);
    assert.equal(result.status, 'ABSENT_VERIFIED');
    assert.deepEqual(result.evidence.map(x => x.filter), ['ALL', 'ACTIVE', 'EXPIRED']);
  }
  assert.equal((await adapterFor({}, { coverageVerified: false }).verifyAbsent(email)).status, 'MANUAL_REVIEW');
});

test('remaining alignment in any view, partial unalign, or missing expected discipline blocks success', async () => {
  for (const views of [
    { ALL: [row()] }, { ALL: [row(['Not Aligned', ''])] },
    { ACTIVE: [row()] }, { EXPIRED: [row(['Expired', 'Expired'])] },
    { ACTIVE: [row(['Not Aligned', 'Not Aligned'])] }
  ]) assert.equal((await adapterFor(views).verifyAbsent(email)).status, 'UNVERIFIED');
  const result = await adapterFor({ ALL: [row(['Not Aligned'])] }).verifyAbsent(email, ['BLS', 'Heartsaver']);
  assert.equal(result.status, 'UNVERIFIED');
});

test('coverage and wrong-company guards run before opening any removal dialog', async () => {
  let touched = false;
  const adapter = adapterFor({ ALL: [row()] }, { coverageVerified: false });
  adapter.openUnalignDialog = async () => { touched = true; };
  await assert.rejects(adapter.unalign({ email }), /coverage/);
  assert.equal(touched, false);
  const wrong = new AhaAdapter({ sites: { aha: site } }, { url: () => ahaInstructorUrl(email, '999') });
  await assert.rejects(wrong.openUnalignDialog(email, {}), /scope/);
});

test('source name mismatch cannot open a dialog even when email matches', async () => {
  const adapter = adapterFor({ ALL: [row()] });
  let touched = false;
  adapter.openUnalignDialog = async () => { touched = true; };
  assert.equal((await adapter.inspect({ email, fullName: 'Another Teacher' })).status, 'MANUAL_REVIEW');
  assert.equal((await adapter.unalign({ email, fullName: 'Another Teacher' })).status, 'MANUAL_REVIEW');
  assert.equal(touched, false);
});

test('AHA scope diagnostics do not disclose search emails or unknown parameter values', () => {
  const detail = JSON.stringify(ahaScopeSummary(ahaInstructorUrl(email, '32238') + '&secret=do-not-print'));
  assert.match(detail, /orgId/);
  assert.doesNotMatch(detail, /target@example|do-not-print/);
});

function waitingAdapter({ initialScopeMissing = false, wrongCompany = false, initialTableEmpty = false } = {}) {
  let tick = 0;
  const page = {
    url: () => wrongCompany ? ahaInstructorUrl(email, '999') :
      initialScopeMissing && tick < 2 ? 'https://atlas.heart.org/manage-Instructor?applyTsFilter=true' :
      ahaInstructorUrl(email, '32238'),
    waitForTimeout: async () => { tick++; },
    getByRole: (role, { name } = {}) => {
      if (role === 'table') return { evaluate: async () => initialTableEmpty && tick < 3 ? [] : [row()] };
      if (role === 'textbox') return { inputValue: async () => email };
      if (role === 'alert') return { allTextContents: async () => [initialTableEmpty && tick < 3 ? '' : 'Showing 1item of 1'] };
      if (role === 'combobox') return { evaluate: async () => name === 'Role' ? 'Instructor' : 'All' };
      throw new Error('Unexpected mock selector');
    }
  };
  return { adapter: new AhaAdapter({ sites: { aha: site } }, page), ticks: () => tick };
}

test('AHA readiness waits for initial URL hydration and complete table before allowing search', async () => {
  const { adapter, ticks } = waitingAdapter({ initialScopeMissing: true, initialTableEmpty: true });
  assert.equal((await adapter.waitForSearchView(email, 'ALL', false)).length, 1);
  assert.ok(ticks() >= 7, 'must see complete stable results, not just a visible table shell');
});

test('AHA persistent wrong company stays blocked after read-only waiting', async () => {
  const { adapter } = waitingAdapter({ wrongCompany: true });
  await assert.rejects(adapter.waitForSearchView(email, 'ALL', false), /999/);
});

test('AHA initial readiness failure never clicks the Search control', async () => {
  let filled = false, clicked = false;
  const page = {
    goto: async () => {},
    getByRole: (role) => role === 'table' ? { waitFor: async () => {} } :
      role === 'textbox' ? { waitFor: async () => {}, fill: async () => { filled = true; } } :
      { click: async () => { clicked = true; } }
  };
  const adapter = new AhaAdapter({ sites: { aha: site } }, page);
  adapter.waitForSearchView = async () => { throw new Error('Initial company state not ready'); };
  await assert.rejects(adapter.searchExactRows(email), /not ready/);
  assert.equal(filled, false);
  assert.equal(clicked, false);
});

test('AHA view failure preserves completed evidence and explicitly labels unvisited views',async()=>{
  const adapter=adapterFor({});const search=adapter.searchExactRows;
  adapter.searchExactRows=async(email,status)=>{if(status==='ACTIVE') throw new Error('synthetic expired login');return search(email,status);};
  const result=await adapter.verifyAbsent(email);
  assert.equal(result.status,'UNVERIFIED');
  assert.deepEqual(result.evidence.map(v=>v.status),['ABSENT_IN_VIEW','READ_FAILED','NOT_CHECKED']);
  assert.ok(result.evidence[0].checkedAt);assert.ok(result.evidence[1].checkedAt);
});
