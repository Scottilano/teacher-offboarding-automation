import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArclcAdapter } from '../../src/platforms/arclc.mjs';
import { observeAction } from '../../src/action-observer.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('data/ms-playwright');
const { chromium } = await import('playwright');
const url = 'https://www.redcrosslearningcenter.org/s/manage-instructors';
// All browser traffic is intercepted below. This is an isolated synthetic page,
// not the real site, and needs no login or teacher information.
const html = [
  '<select><option value="company">ALLCPR Inc.</option></select>',
  '<div class="cManageInstructors"><button id="remove">Remove Affiliation</button>',
  '<table role="grid"><thead><tr><th><input type="checkbox"></th><th>Organization</th><th>Address</th><th>Name</th><th>Email</th><th>Phone</th><th>Role</th></tr></thead><tbody id="rows"></tbody></table></div>',
  '<script>',
  'const tbody = document.getElementById("rows");',
  'const records = sessionStorage.removed ? [] : [1,2];',
  'function add(n, role) { const tr = document.createElement("tr"); tr.innerHTML = "<td><x-box></x-box></td><th>ALLCPR Inc.</th><td>Address</td><th>Test Teacher</th><th>target@example.com</th><th>000</th><td>"+role+"</td>"; tbody.append(tr); const host=tr.querySelector("x-box"); host.attachShadow({mode:"open"}).innerHTML = \'<label><input type="checkbox"><span class="slds-checkbox_faux">Select</span></label>\'; }',
  'records.forEach(n => add(n,"Instructor")); add(3,"Administrator");',
  'if(sessionStorage.preselectAdmin) tbody.lastElementChild.querySelector("x-box").shadowRoot.querySelector("input").checked = true;',
  'document.getElementById("remove").onclick = () => { sessionStorage.removeClicks = String(Number(sessionStorage.removeClicks || 0) + 1); if(confirm("Remove selected Instructor affiliations?")) { if(sessionStorage.partial) { tbody.querySelector("tr").remove(); } else { sessionStorage.removed="yes"; [...tbody.querySelectorAll("tr")].filter(tr=>tr.lastChild.textContent==="Instructor").forEach(tr=>tr.remove()); } } };',
  '</script>'
].join('\n');

test('ARC rendered coverage crosses shadow roots, detects delayed rows and blocks paging and mismatched identities',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    let content=html;
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:content}));
    await page.goto(url);
    const adapter=new ArclcAdapter({sites:{arclc:{implementationStatus:'ready',organizationLabel:'ALLCPR Inc.'}},safety:{tableTimeoutMs:15000}},page);
    assert.equal((await adapter.unalign({email:'target@example.com',fullName:'Different Person'})).status,'MANUAL_REVIEW');
    assert.equal(await page.evaluate(()=>sessionStorage.removeClicks||'0'),'0');
    // The declared total proves that a stable partial table must continue waiting.
    content=html+'<script>document.querySelector("table").setAttribute("aria-rowcount","5");setTimeout(()=>add(4,"Instructor"),5500);</script>';
    assert.equal((await adapter.freshMatches('target@example.com')).length,4);
    assert.equal(adapter.coverageEvidence.rowCount,4);
    content=html+'<script>document.querySelector(".cManageInstructors").insertAdjacentHTML("beforeend", "<button>Next</button>")</script>';
    await assert.rejects(adapter.freshMatches('target@example.com'),/Next or Load More/);
    content=html+'<script>const t=document.querySelector("table");const host=document.createElement("x-grid");t.replaceWith(host);host.attachShadow({mode:"open"}).append(t);</script>';
    assert.equal((await adapter.freshMatches('target@example.com')).length,3);
    assert.equal(adapter.coverageEvidence.knownRegion,true);
  } finally {await browser.close();}
});

test('browser native confirm: default cancel reproduced; fixed handler and refreshed zero-row verification succeed', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    const page = await context.newPage();
    await page.goto(url);
    await page.getByRole('button', { name: 'Remove Affiliation' }).click();
    assert.equal(await page.getByRole('row').count(), 4, 'unhandled confirm auto-dismisses without deleting');
    const reportsDir = await mkdtemp(path.join(os.tmpdir(), 'offboarding-browser-test-'));
    const adapter = new ArclcAdapter({
      sites: { arclc: { implementationStatus: 'ready', organizationLabel: 'ALLCPR Inc.' } },
      safety: { verificationTimeoutMs: 10 },
      runtime: { reportsDir, confirmDialog: async ({ message }) => message === 'Remove selected Instructor affiliations?' }
    }, page);
    const result = await adapter.unalign({ email: 'target@example.com', fullName:'Test Teacher' });
    assert.equal(result.status, 'REMOVED', result.detail);
    assert.equal(await page.getByRole('row').count(), 2, 'Administrator preserved after reload');
    const evidence = await adapter.readTable();
    assert.equal(evidence[1].cells[6], 'Administrator');
  } finally { await browser.close(); }
});

test('partial removal and wrong selections never pass as successful deletion', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(() => { sessionStorage.partial = 'yes'; });
    const reportsDir = await mkdtemp(path.join(os.tmpdir(), 'offboarding-partial-test-'));
    const adapter = new ArclcAdapter({
      sites: { arclc: { implementationStatus: 'ready', organizationLabel: 'ALLCPR Inc.' } },
      safety: { verificationTimeoutMs: 10 },
      runtime: { reportsDir, confirmDialog: async () => true }
    }, page);
    const result = await adapter.unalign({ email: 'target@example.com', fullName:'Test Teacher' });
    assert.equal(result.status, 'UNVERIFIED', result.detail);
    const clicksBefore = await page.evaluate(() => Number(sessionStorage.removeClicks || 0));
    assert.equal(clicksBefore, 1, 'partial-removal scenario reached exactly one submission');
    // The production preflight intentionally reloads; a transient checkbox set
    // only on the old DOM must not be mistaken for a post-refresh selection.
    await page.getByRole('row').last().getByRole('checkbox').check();
    await adapter.freshMatches('target@example.com');
    assert.equal((await adapter.readSelections()).length, 0, 'fresh read clears stale page selections');
    assert.equal(await page.evaluate(() => Number(sessionStorage.removeClicks || 0)), clicksBefore, 'fresh read never submits');
    // Reproduce an unexpected Administrator selection on the newly loaded DOM.
    await page.evaluate(() => { sessionStorage.preselectAdmin = 'yes'; });
    await assert.rejects(() => adapter.unalign({ email: 'target@example.com', fullName:'Test Teacher' }), /Existing checked rows/);
    assert.equal(await page.getByRole('row').last().getByRole('checkbox').isChecked(), true, 'guard saw a real checked Administrator after reload');
    assert.equal(await page.evaluate(() => Number(sessionStorage.removeClicks || 0)), clicksBefore, 'wrong selection never reaches Remove');
  } finally { await browser.close(); }
});

test('real native alert text is recorded even though it is absent from DOM', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button onclick="alert(\'Please select an instructor\')">Remove</button>');
    const observer = observeAction(page);
    await page.getByRole('button').click();
    await observer.settle();
    assert.equal(observer.blocked, true);
    assert.equal(observer.events.find(event => event.kind === 'native-dialog').message, 'Please select an instructor');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await observer.stop();
  } finally { await browser.close(); }
});
