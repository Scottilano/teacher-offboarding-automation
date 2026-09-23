import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AhaAdapter, readAhaTable, ahaInstructorUrl, selectAhaDisciplines } from '../../src/platforms/aha.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('data/ms-playwright');
const { chromium } = await import('playwright');

// Synthetic fixtures only: every request is intercepted, with no real Atlas data.
const fixture = mode => `<!doctype html>
<label>Search<input aria-label="Search" id="search"></label><button id="searchButton">Search</button>
<div title="Instructor"><input role="combobox" aria-label="Role"></div>
<div id="filterTitle"><input role="combobox" aria-label="Alignment Status"></div>
<button disabled>Export in CSV format</button>
<table aria-label="Manage Instructors"><thead><tr><th>Instructor</th></tr></thead><tbody id="rows"></tbody></table>
<div role="alert" id="pagination"></div>
<div id="UnalignInstructor" role="dialog" hidden>
<h2>Remove alignment for Test Teacher</h2>
<p>Choose which disciplines to remove alignment for Test Teacher from ALLCPR.</p>
<style>
.discipline { position:relative; height:32px; width:180px; }
.discipline input { position:absolute; left:0; top:0; width:22px; height:22px; margin:0; }
.discipline label { position:absolute; inset:0; padding-left:30px; z-index:1; cursor:pointer; }
</style>
<div class="discipline"><input type="checkbox" id="Basic Life Support"><label for="Basic Life Support">BLS </label></div>
<div class="discipline"><input type="checkbox" id="Heartsaver"><label for="Heartsaver">Heartsaver</label></div>
<button id="cancel">Cancel</button><button id="remove" title="Remove Alignment" disabled>Remove Alignment</button>
</div>
<script>
const mode = "${mode}";
const params = new URLSearchParams(location.search);
const status = params.get('expiryStatus');
const search = document.getElementById('search');
search.value = params.get('nameOrEmailOrInstructorId') || '';
document.getElementById('filterTitle').title = {ALL:'All',ACTIVE:'Active',EXPIRED:'Expired'}[status];
const rows = document.getElementById('rows'), pagination = document.getElementById('pagination');
const removed = sessionStorage.removed === 'yes';
const visible = status === 'ALL' || (status === 'ACTIVE' && (!removed || mode === 'partial'));
const discipline = (name, unaligned) => '<div class="dynamicTable_disciplineIcon__test"><div>Active Since<br>01-01-2025<span class="dynamicTable_status__test">' + (unaligned?'Not Aligned':'') + '</span></div><span class="' + (unaligned?'dynamicTable_spanTagStyling__test':'dynamicTable_spanStyleActive__test') + '">' + name + '</span></div>';
if (visible) {
 rows.innerHTML = '<tr><td data-title="Instructor"><span title="Test Teacher">Test Teacher</span></td><td data-title="Email Address"><div title="target@example.com">target@example.com</div></td><td data-title="Organization"><div title="ALLCPR">ALLCPR</div></td><td data-title="Discipline">' + discipline('BLS',removed) + discipline('Heartsaver',removed && mode !== 'partial') + '</td><td data-title="Actions"><button aria-label="More Action" id="more">More Action</button><button id="unalign" hidden>Unalign</button></td></tr>';
 pagination.textContent='Showing 1item of 1';
 document.getElementById('more').onclick=()=>document.getElementById('unalign').hidden=false;
 document.getElementById('unalign').onclick=()=>{
   document.getElementById('UnalignInstructor').hidden=false;
   if(mode==='wrong-dialog') document.querySelector('#UnalignInstructor p').textContent='Choose which disciplines to remove alignment for Another Person from ALLCPR.';
 };
} else { pagination.textContent='No Results Found'; }
let hydrated = mode !== 'hydrating';
if (!hydrated) {
 const savedRows = rows.innerHTML, savedPagination = pagination.textContent;
 rows.innerHTML = ''; pagination.textContent = '';
 setTimeout(() => {
  rows.innerHTML = savedRows; pagination.textContent = savedPagination; hydrated = true;
 }, 700);
}
document.getElementById('searchButton').onclick=()=>{
 if (!hydrated) {
  const wrong = new URL(location.href); wrong.searchParams.delete('orgId');
  history.replaceState(null, '', wrong);
 }
};
const dialog=document.getElementById('UnalignInstructor');
const bls=document.getElementById('Basic Life Support'), hs=document.getElementById('Heartsaver'), remove=document.getElementById('remove');
bls.onchange=hs.onchange=()=>remove.disabled=!(bls.checked && hs.checked);
document.getElementById('cancel').onclick=()=>dialog.hidden=true;
remove.onclick=()=>{sessionStorage.removed='yes';dialog.hidden=true;};
</script>`;

async function withFixture(mode, work) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture(mode) }));
    const page = await context.newPage();
    const reportsDir = await mkdtemp(path.join(os.tmpdir(), 'aha-fixture-'));
    const adapter = new AhaAdapter({ sites: { aha: { organizationId: '32238', implementationStatus: 'ready', coverageVerified: true } }, runtime: { reportsDir } }, page);
    await work(adapter, page);
  } finally { await browser.close(); }
}

test('AHA adapter verifies historical Not Aligned rows across three fresh views without export', async () => {
  await withFixture('complete', async (adapter, page) => {
    assert.equal((await adapter.inspect({ email: 'target@example.com' })).status, 'READY');
    const result = await adapter.unalign({ email: 'target@example.com' });
    assert.equal(result.status, 'REMOVED', result.detail);
    assert.deepEqual(result.evidence.map(e => e.filter), ['ALL', 'ACTIVE', 'EXPIRED']);
    const records = await adapter.searchExactRows('target@example.com');
    assert.equal(records[0].disciplines[0].name, 'BLS');
    assert.equal(records[0].disciplines[0].status, 'Not Aligned');
    assert.equal(await page.getByRole('button', { name: 'Export in CSV format' }).isEnabled(), false);
    await page.locator('thead').evaluate(node => node.remove());
    assert.equal((await page.getByRole('table').evaluate(readAhaTable)).length, 1, 'mobile header absence must not drop teacher');
  });
});

test('AHA browser partial removal cannot be reported as REMOVED', async () => {
  await withFixture('partial', async adapter => {
    const result = await adapter.unalign({ email: 'target@example.com' });
    assert.equal(result.status, 'UNVERIFIED', result.detail);
  });
});

test('AHA browser mismatched confirmation identity prevents submission', async () => {
  await withFixture('wrong-dialog', async (adapter, page) => {
    await assert.rejects(adapter.unalign({ email: 'target@example.com' }), /expected teacher/);
    assert.equal(await page.evaluate(() => sessionStorage.removed), undefined);
  });
});

test('AHA browser waits for hydration before Search can overwrite the company scope', async () => {
  await withFixture('hydrating', async adapter => {
    const records = await adapter.searchExactRows('target@example.com');
    assert.equal(records.length, 1);
  });
});

test('AHA overlay reproduces native check interception; associated-label selection succeeds without submitting', async () => {
  await withFixture('complete', async (adapter, page) => {
    await page.goto(ahaInstructorUrl('target@example.com', '32238'));
    await page.getByRole('button', { name: 'More Action', exact: true }).click();
    await page.getByRole('button', { name: 'Unalign', exact: true }).click();
    const dialog = page.locator('#UnalignInstructor');
    await assert.rejects(dialog.getByRole('checkbox').first().check({ timeout: 500 }), /intercepts pointer events/);
    await selectAhaDisciplines(dialog, ['Heartsaver', 'BLS']);
    assert.deepEqual(await dialog.getByRole('checkbox').evaluateAll(nodes => nodes.map(n => n.checked)), [true, true]);
    assert.equal(await dialog.getByRole('button', { name: 'Remove Alignment', exact: true }).isEnabled(), true);
    assert.equal(await page.evaluate(() => sessionStorage.removed), undefined);
  });
});
