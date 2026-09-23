import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLocalServer } from '../../src/local/server.mjs';
import { LocalCoordinator } from '../../src/local/jobs.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('data/ms-playwright');
const {chromium}=await import('playwright');

test('UI defers only a confirmed unresolved platform item and reveals an exported report',async()=>{
  const baseDir=await mkdtemp(path.join(os.tmpdir(),'offboarding-deferral-ui-'));
  const config={runtime:{baseDir,reportsDir:path.join(baseDir,'reports')},safety:{maxExecuteActions:10},sites:{arclc:{enabled:true,implementationStatus:'ready',organizationLabel:'ALLCPR Inc.'},aha:{enabled:true,implementationStatus:'ready',coverageVerified:true,organizationId:'32238'}}};
  const actions=[],revealed=[];
  const coordinator=new LocalCoordinator(config,{sessionChecker:async()=>({status:'READY',detail:'mock'}),openSession:async()=>({page:{isClosed:()=>false},context:{close:async()=>{}}}),
    adapterFactory:()=>({unalign:async item=>{actions.push(item.email);return item.email==='review@example.com'?{status:'MANUAL_REVIEW',detail:'Synthetic identity mismatch'}:{status:'REMOVED',detail:'Synthetic removal'};}})});
  const app=await startLocalServer({config,coordinator,revealFile:async file=>revealed.push(file)});
  let browser;
  try {
    browser=await chromium.launch({headless:true});const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).origin===app.origin?route.continue():route.abort());
    await page.goto(app.url);
    await page.locator('#file').setInputFiles({name:'review.csv',mimeType:'text/csv',buffer:Buffer.from('Full Name,Email\nReview Person,review@example.com\nOther Person,other@example.com')});
    await page.locator('#import').click();await page.locator('#create').click();await page.locator('#job').waitFor();
    await page.locator('#login-arc').click();
    await page.waitForFunction(()=>document.querySelector('#login-state').textContent.includes('ARCLC: Last check passed'));
    await page.locator('#approved').check();await page.locator('#execute').click();
    const defer=page.getByRole('button',{name:'Defer This Item: Review Person / ARCLC',exact:true});
    await defer.click();assert.equal(await page.locator('#defer-confirm').isDisabled(),true);
    await page.locator('#defer-reason').fill('Create a new job after manual review');assert.equal(await page.locator('#defer-confirm').isDisabled(),true);
    await page.locator('#defer-approved').check();await page.locator('#defer-confirm').click();
    await page.waitForFunction(()=>document.querySelector('#job-rows').textContent.includes('Deferred; not complete'));
    assert.equal(await page.locator('#approved').isChecked(),false);
    await page.locator('#approved').check();await page.locator('#execute').click();
    await page.waitForFunction(()=>document.querySelector('#job-counts').textContent.includes('1 / 2'));
    assert.deepEqual(actions,['review@example.com','other@example.com']);
    assert.equal(await page.locator('#reveal-result').isDisabled(),true);
    await page.locator('#export').click();await page.locator('#reveal-result').click();
    await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Requested Finder'));
    assert.equal(revealed.length,1);
    const text=await readFile(revealed[0],'utf8');assert.match(text,/DEFERRED/);assert.match(text,/REMOVED/);
  } finally {await browser?.close();await app.close();}
});

test('dual-platform UI waits for batch finalization before renewed authorization', {timeout:90000}, async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(),'offboarding-dual-ui-'));
  const protectedTeachers = Array.from({length:4},(_,i)=>({fullName:'Synthetic Protected '+i,email:`protected${i}@example.com`,reason:'Test configuration only'}));
  const config = {runtime:{baseDir,reportsDir:path.join(baseDir,'reports')},safety:{maxExecuteActions:10,protectedTeachers},sites:{arclc:{enabled:true,implementationStatus:'ready',organizationLabel:'ALLCPR Inc.'},aha:{enabled:true,implementationStatus:'ready',coverageVerified:true,organizationId:'32238',maxBatchActions:3}}};
  const actions = [], logins = [];
  const coordinator = new LocalCoordinator(config, {
    sessionChecker:async platform => {logins.push(platform);return {status:'READY',detail:'isolated check'};},
    openSession:async()=>({page:{isClosed:()=>false},context:{close:async()=>{}}}),
    adapterFactory:platform=>({unalign:async item=>{actions.push([platform,item.email]);return {status:'REMOVED',detail:'Simulated result; no live website action'};}})
  });
  const app = await startLocalServer({config,coordinator});
  const historyReached = Promise.withResolvers(), historyGate = Promise.withResolvers();
  let holdHistory = false, historyHeld = false;
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== app.origin) return route.abort();
      if (url.pathname === '/api/jobs' && holdHistory && !historyHeld) {
        historyHeld = true; historyReached.resolve(); await historyGate.promise;
      }
      return route.continue();
    });
    await page.goto(app.url);
    const csv = ['Full Name,Email',...config.safety.protectedTeachers.map(t=>t.fullName+','+t.email),'Example One,one@example.com','Example Two,two@example.com'].join('\n');
    await page.locator('#file').setInputFiles({name:'isolated.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
    await page.locator('#import').click();
    await page.locator('#preview').waitFor({state:'visible'});
    assert.equal(await page.locator('#preview-rows button[data-protected="true"]:disabled').count(),4);
    assert.match(await page.locator('#preview-summary').innerText(), /Included: 2; excluded: 4/);
    await page.locator('#aha').check();
    await page.locator('#create').click();
    await page.locator('#job').waitFor({state:'visible'});
    assert.equal(await page.locator('#job-rows tr').count(),4);
    assert.equal(await page.locator('#job-excluded-rows tr').count(),4);
    assert.equal(await page.locator('#limit').getAttribute('max'),'3');
    await page.locator('#login-arc').click();
    await page.waitForFunction(()=>document.querySelector('#login-state').textContent.includes('ARCLC: Last check passed'));
    await page.locator('#login-aha').click();
    await page.waitForFunction(()=>document.querySelector('#login-state').textContent.includes('AHA: Last check passed'));
    assert.equal(actions.length,0);
    await page.locator('#approved').check();
    holdHistory = true;
    await page.locator('#execute').click();
    await page.waitForFunction(()=>document.querySelector('#job-counts').textContent.includes('3 / 4'));
    await historyReached.promise;
    assert.equal(actions.length,3);
    assert.equal(await page.locator('#approved').isDisabled(),true,'completed counts must not unlock authorization while history is still refreshing');
    assert.equal(await page.locator('#approved').isChecked(),false);
    assert.equal(await page.locator('#execute').isDisabled(),true);
    historyGate.resolve();
    await page.waitForFunction(()=>!document.querySelector('#approved').disabled);
    assert.equal(await page.locator('#approved').isChecked(),false,'completion never authorizes the next batch');
    await page.locator('#approved').check();
    await page.locator('#execute').click();
    await page.waitForFunction(()=>document.querySelector('#job-counts').textContent.includes('4 / 4'));
    assert.deepEqual(actions,[['arclc','one@example.com'],['arclc','two@example.com'],['aha','one@example.com'],['aha','two@example.com']]);
    assert.deepEqual(logins,['arclc','aha','arclc','arclc','aha','aha']);
  } finally {historyGate.resolve();await browser?.close();await app.close();}
});

test('local UI import, preview, explicit approval, mock execution, export and recovery', async () => {
  const baseDir=await mkdtemp(path.join(os.tmpdir(),'offboarding-ui-'));
  const config={runtime:{baseDir,reportsDir:path.join(baseDir,'reports')},safety:{maxExecuteActions:10},sites:{arclc:{enabled:true,implementationStatus:'ready',organizationLabel:'ALLCPR Inc.',loginUrl:'https://example.invalid/'},aha:{enabled:true,implementationStatus:'discovery_complete',organizationId:'32238',coverageVerified:false}}};
  let actions=0;
  const coordinator=new LocalCoordinator(config,{sessionChecker: async () => ({status:'READY', detail:'synthetic login check'}), openSession:async()=>({page:{isClosed:()=>false,goto:async()=>{}},context:{close:async()=>{}}}),adapterFactory:()=>({unalign:async()=>{actions++; return {status:'REMOVED',detail:'Isolated test: refreshed verification succeeded (synthetic data)'};},inspect:async()=>({status:'READY',detail:'isolated'})})});
  const app=await startLocalServer({config,coordinator});
  let browser;
  try {
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1100}});
    const page=await context.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).origin===app.origin?route.continue():route.abort());
    await page.goto(app.url);
    await page.locator('#file').setInputFiles({name:'synthetic-roster.csv',mimeType:'text/csv',buffer:Buffer.from('Full Name,Email,Status\nExample Teacher,example1@example.com,Active\nExample Teacher,EXAMPLE1@example.com,Departed\nSecond Teacher,example2@example.com,Departed\n')});
    await page.getByRole('button',{name:'Read Roster',exact:true}).click();
    await page.getByRole('button',{name:'Save Local Job'}).waitFor({state:'visible'});
    assert.equal(await page.locator('#protection-note').isVisible(),false,'ordinary imports show no permanent protection banner');
    assert.equal(await page.locator('#preview-rows button[data-protected="true"]').count(),0);
    assert.match(await page.locator('#message').innerText(), /Manually exclude/);
    assert.equal(await page.locator('#preview-rows tr').count(),2); assert.equal(actions,0);
    const firstExclude = 'Exclude from Job: Example Teacher (example1@example.com)';
    await page.getByRole('button', {name:firstExclude, exact:true}).click();
    assert.match(await page.locator('#counts').innerText(), /1Excluded/);
    await page.locator('#excluded-only').check();
    assert.equal(await page.locator('#preview-rows tr').count(), 1);
    await page.getByRole('button', {name:'Include in Job: Example Teacher (example1@example.com)', exact:true}).click();
    assert.equal(await page.locator('#preview-rows tr').count(), 0);
    await page.locator('#excluded-only').uncheck();
    await page.getByRole('button', {name:firstExclude, exact:true}).click();
    await page.getByRole('button', {name:'Exclude from Job: Second Teacher (example2@example.com)', exact:true}).click();
    assert.equal(await page.locator('#create').isDisabled(), true, 'empty task cannot be saved');
    await page.getByRole('button', {name:'Include in Job: Second Teacher (example2@example.com)', exact:true}).click();
    await page.locator('#preview-search').fill('EXAMPLE1@');
    assert.equal(await page.locator('#preview-rows tr').count(), 1);
    assert.match(await page.locator('#preview-summary').innerText(), /Included: 1; excluded: 1/);
    // Saving while filtered must still include the non-excluded, hidden teacher.
    await page.getByRole('button',{name:'Save Local Job'}).click();
    await page.locator('#job').waitFor({state:'visible'});
    assert.equal(await page.locator('#job-rows tr').count(), 1);
    assert.match(await page.locator('#job-rows').innerText(), /example2@example.com/);
    assert.match(await page.locator('#job-excluded-rows').innerText(), /example1@example.com/);
    assert.equal(await page.locator('#execute').isDisabled(),true);
    await page.getByRole('button',{name:'Check Login / Open ARCLC'}).click();
    await page.waitForFunction(()=>document.querySelector('#login-state').textContent.includes('ARCLC: Last check passed'));
    await page.locator('#approved').check();
    await page.getByRole('button',{name:'Execute Next Batch'}).click();
    await page.waitForFunction(()=>document.querySelector('#job-counts').textContent.includes('1 / 1'));
    assert.equal(actions,1);
    const [savedJob] = await coordinator.store.list();
    assert.equal((await coordinator.store.load(savedJob.id)).excludedTeachers.length, 1);
    await page.getByRole('button',{name:'Export Results CSV'}).click();
    await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Results CSV saved locally'));
    assert.match(await readFile(path.join(baseDir, 'reports/results/offboarding-'+savedJob.id+'.csv'), 'utf8'), /EXCLUDED/);
    assert.equal(await page.locator('#export').isEnabled(),true,'export remains available after the first report');
    await page.getByRole('button',{name:'Export Results CSV'}).click();
    await page.reload(); await page.waitForFunction(()=>document.querySelector('#history').options.length===2);
    await page.locator('#history').selectOption({index:1}); await page.getByRole('button',{name:'Open Job',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#job-counts').textContent.includes('1 / 1'));
    assert.equal(await page.locator('#job-excluded-rows tr').count(), 1);
    assert.equal(actions,1);
    await page.screenshot({path:path.resolve('reports/local-ui-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.resolve('reports/local-ui-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  } finally {await browser?.close();await app.close();}
});
