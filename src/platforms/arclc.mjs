import { PlatformAdapter } from './base.mjs';
import { assertNotProtected } from '../protection.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { observeAction } from '../action-observer.mjs';
import { visibleSessionProblem, openLoginEntry } from '../session-check.mjs';
import { readCoverageDom, scrollCoverageDom, coverageDecision } from './arclc-coverage.mjs';

const MANAGE_INSTRUCTORS_URL = 'https://www.redcrosslearningcenter.org/s/manage-instructors';
const normalizeName = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const identityIssue = (matches, item) => !normalizeName(item.fullName) || matches.some(row => !normalizeName(row.name) || normalizeName(row.name) !== normalizeName(item.fullName));

export class ArclcAdapter extends PlatformAdapter {
  constructor(config, page) {
    super('arclc', config, page);
    this.loadedRowCount = 0;
  }

  async firstVisible(selectors) {
    for (const selector of selectors) {
      const candidates = await this.page.locator(selector).all();
      for (const candidate of candidates) {
        if (await candidate.isVisible()) return candidate;
      }
    }
    return null;
  }

  async waitForGrid(grid, timeout) {
    try {
      await grid.waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  }

  async dismissCookieBanner() {
    const accept = this.page
      .getByRole('button', { name: /Accept all Cookies/i })
      .filter({ visible: true });
    if (await accept.count()) {
      await accept.first().click();
      await this.page.waitForTimeout(300);
    }
  }

  async visibleNonCookieDialogTexts() {
    const dialogs = await this.page.getByRole('dialog').filter({ visible: true }).allTextContents();
    return dialogs
      .map(text => text.replace(/\s+/g, ' ').trim())
      .filter(text => text && !/cookies|privacy policy|manage preferences/i.test(text));
  }

  async autoLogin() {
    const credentials = this.config.runtimeCredentials?.arclc;
    if (!credentials?.username || !credentials?.password) return false;

    await this.page.goto(this.config.sites.arclc.loginUrl, { waitUntil: 'domcontentloaded' });
    await this.page.locator('input[autocomplete="username"], input#username').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    let username = await this.firstVisible([
      'input[autocomplete="username"]',
      'input[name="username"]',
      'input[id="username"]',
      'input[type="email"]'
    ]);
    if (!username) {
      const loginEntry = await this.firstVisible([
        'a[href*="login" i]',
        'button:has-text("Log In")',
        'button:has-text("Sign In")'
      ]);
      if (loginEntry) {
        await loginEntry.click();
        await this.page.waitForTimeout(1000);
        username = await this.firstVisible([
          'input[autocomplete="username"]',
          'input[name="username"]',
          'input[id="username"]',
          'input[type="email"]'
        ]);
      }
    }
    if (!username) {
      await this.throwGridDiagnostic('ARCLC login username field was not found on the configured login page.');
    }
    await username.fill(credentials.username);

    let password = await this.firstVisible(['input[type="password"]', 'input[autocomplete="current-password"]']);
    if (!password) {
      const next = await this.firstVisible(['button:has-text("Next")', 'button:has-text("Continue")']);
      if (next) {
        await next.click();
        await this.page.waitForTimeout(1000);
        password = await this.firstVisible(['input[type="password"]', 'input[autocomplete="current-password"]']);
      }
    }
    if (!password) {
      await this.throwGridDiagnostic('ARCLC login password field was not found.');
    }
    await password.fill(credentials.password);

    const submit = await this.firstVisible([
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log In")',
      'button:has-text("Sign In")'
    ]);
    if (!submit) {
      await this.throwGridDiagnostic('ARCLC login submit button was not found.');
    }
    await submit.click();
    try {
      await this.page.waitForURL(url => url.hostname === 'www.redcrosslearningcenter.org' && url.pathname.startsWith('/s/'), { timeout: 45000 });
    } catch {
      await this.throwGridDiagnostic('ARCLC sign-in did not complete. Check credentials, MFA or visible login errors.');
    }
    return true;
  }

  async throwGridDiagnostic(message) {
    const diagnostic = await this.saveDiagnostic('arclc');
    throw new Error(
      `${message} URL: ${diagnostic.url}; title: ${diagnostic.title}; ` +
      `frames: ${diagnostic.frameUrls.join(', ') || 'none'}; screenshot: ${diagnostic.screenshotPath}; ` +
      `details: ${diagnostic.detailsPath}`
    );
  }

  async saveDiagnostic(prefix, extra = {}) {
    const diagnosticsDir = path.join(this.config.runtime.reportsDir, 'diagnostics');
    await mkdir(diagnosticsDir, { recursive: true });
    const stamp = Date.now();
    const screenshotPath = path.join(diagnosticsDir, `${prefix}-${stamp}.png`);
    const detailsPath = path.join(diagnosticsDir, `${prefix}-${stamp}.json`);
    await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const title = await this.page.title().catch(() => 'unknown');
    const frameUrls = this.page.frames().map(frame => frame.url()).filter(Boolean);
    const visibleText = async locator => locator.filter({ visible: true }).allTextContents().catch(() => []);
    const details = {
      timestamp: new Date().toISOString(),
      url: this.page.url(),
      title,
      frameUrls,
      dialogs: await visibleText(this.page.locator('[role="dialog"], [role="alertdialog"], section.slds-modal')),
      alerts: await visibleText(this.page.getByRole('alert')),
      buttons: await visibleText(this.page.getByRole('button')),
      ariaSelectedRows: await this.page.locator('tr[aria-selected="true"]').count().catch(() => -1),
      checkedRows: await this.readSelections().catch(() => []),
      coverage: this.coverageEvidence || null,
      ...extra
    };
    await writeFile(detailsPath, `${JSON.stringify(details, null, 2)}\n`, { mode: 0o600 });
    return { ...details, screenshotPath, detailsPath };
  }


  async readTable() {
    const grid = this.page.getByRole('grid');
    if (await grid.count() !== 1) throw new Error('Expected one ARCLC instructor grid.');
    return grid.getByRole('row').evaluateAll(rows => rows.map(row => ({
      cells: [...row.children].map(cell => (cell.textContent || '').trim().replace(/\s+/g, ' ')),
      checked: row.querySelector('input[type="checkbox"]')?.checked === true,
      ariaSelected: row.getAttribute('aria-selected')
    })));
  }

  async prepare() {
    this.coverageEvidence = null;
    this.assertInspectable();
    const target = this.config.sites.arclc.organizationLabel;
    if (target !== 'ALLCPR Inc.') throw new Error('ARCLC is authorized only for ALLCPR Inc.');
    if (!this.page.url().includes('/s/manage-instructors')) {
      await this.page.goto(MANAGE_INSTRUCTORS_URL, { waitUntil: 'domcontentloaded' });
    }
    const grid = this.page.getByRole('grid');
    if (!await this.waitForGrid(grid, 8000)) {
      if (!await this.autoLogin()) {
        await openLoginEntry('arclc', this.config, this.page);
        throw new Error('ARCLC session is unverified or the instructor page is unavailable. The sign-in page was opened. Sign in through the automated browser, then inspect unfinished items. No removal was automatically retried.');
      }
      await this.page.goto(MANAGE_INSTRUCTORS_URL, { waitUntil: 'domcontentloaded' });
      if (!await this.waitForGrid(grid, 60000)) await this.throwGridDiagnostic('ARCLC login did not reach the instructor grid.');
    }
    await this.dismissCookieBanner();
    const select = this.page.locator('select');
    if (await select.count() !== 1) throw new Error('ARCLC organization selector missing or ambiguous.');
    const option = select.getByRole('option', { name: target, exact: true });
    if (await option.count() !== 1) throw new Error('ALLCPR Inc. organization option missing or ambiguous.');
    const value = await option.getAttribute('value');
    if (!value || value === 'ALL') throw new Error('Invalid ALLCPR organization value.');
    if (await select.inputValue() !== value) await select.selectOption({ label: target });

    await grid.evaluate(scrollCoverageDom, true);
    let previous = '', previousData = [];
    let stable = 0;
    const deadline = Date.now() + (this.config.safety.tableTimeoutMs || 60000);
    while (Date.now() < deadline) {
      const loading = await this.page.locator('div.cManageInstructors lightning-spinner').filter({ visible: true }).count();
      const rows = await this.readTable();
      const headers = rows[0]?.cells || [];
      if (headers.length !== 7 || !/Email/i.test(headers[4]) || !/Role/i.test(headers[6])) {
        throw new Error('ARCLC table headers changed; refusing to infer identity columns.');
      }
      const data = rows.slice(1);
      // A virtualized/reordered table could hide rows seen earlier. Do not infer absence.
      if (previousData.length && (data.length < previousData.length || previousData.some((cells,i) => JSON.stringify(cells) !== JSON.stringify(data[i]?.cells)))) {
        throw new Error('ARC rows shrank or changed pages during scanning. Completeness is unknown; absence was not inferred.');
      }
      previousData = data.map(row => row.cells);
      const valid = data.length > 0 && data.every(row => row.cells.length === 7 && row.cells[1] === target && row.cells[4].includes('@'));
      const coverage = await grid.evaluate(readCoverageDom);
      const decision = coverageDecision(coverage, data.length);
      if (decision.fatal) throw new Error(decision.detail);
      const signature = JSON.stringify({rows:data.map(row => row.cells),coverage});
      if (this.coverageNetwork?.failed) throw new Error('ARC list loading failed or the session expired. Completeness was not verified.');
      const networkReady = !this.coverageNetwork || (!this.coverageNetwork.pending.size && Date.now() - this.coverageNetwork.changedAt >= 1500);
      if (!loading && valid && decision.complete && networkReady && await select.inputValue() === value) {
        stable = signature === previous ? stable + 1 : 0;
        if (stable >= 8) {
          this.loadedRowCount = data.length;
          this.coverageEvidence = {checkedAt:new Date().toISOString(),organization:target,rowCount:data.length,...coverage,method:'rendered nonpaginated list scanned to end; stable for 8 samples'};
          return data;
        }
      } else stable = 0;
      previous = signature;
      await grid.evaluate(scrollCoverageDom, false);
      await this.page.waitForTimeout(500);
    }
    throw new Error('ALLCPR table did not reach a complete, stable nonempty state; absence cannot be inferred.');
  }

  async searchExactRows(email) {
    await this.prepare();
    const normalized = email.trim().toLowerCase();
    const rows = this.page.getByRole('grid').getByRole('row');
    const data = await this.readTable();
    const matches = [];
    for (let i = 1; i < data.length; i++) {
      const cells = data[i].cells;
      if (cells[4]?.trim().toLowerCase() !== normalized) continue;
      if (cells[1] !== 'ALLCPR Inc.') throw new Error('Matched affiliation outside ALLCPR Inc.');
      matches.push({ row: rows.nth(i), organization: cells[1], role: cells[6], name: cells[3] });
    }
    return matches;
  }

  async freshMatches(email) {
    const state = {pending:new Set(),changedAt:Date.now(),failed:false};
    this.coverageNetwork = state;
    const relevant = request => {
      try { return new URL(request.url()).origin === 'https://www.redcrosslearningcenter.org' && ['xhr','fetch'].includes(request.resourceType()); } catch { return false; }
    };
    const request = r => { if (relevant(r)) {state.pending.add(r);state.changedAt=Date.now();} };
    const finished = r => {if(relevant(r)){state.pending.delete(r);state.changedAt=Date.now();}};
    const failed = r => {if(relevant(r)) state.failed=true;finished(r);};
    const response = r => {if(relevant(r.request()) && r.status()>=400) state.failed=true;};
    const listeners = [['request',request],['requestfinished',finished],['requestfailed',failed],['response',response]];
    for(const [event,handler] of listeners) this.page.on(event,handler);
    try {await this.page.reload({ waitUntil: 'domcontentloaded' });return await this.searchExactRows(email);}
    finally {for(const [event,handler] of listeners) this.page.off(event,handler);this.coverageNetwork=null;}
  }

  async inspect(item) {
    if (!normalizeName(item.fullName)) return {status:'MANUAL_REVIEW',detail:'ARC source name is missing. Email alone cannot authorize processing.'};
    const matches = await this.freshMatches(item.email);
    if (!matches.length) {
      const fresh = await this.freshMatches(item.email);
      if (!fresh.length) return { status: 'ABSENT_VERIFIED', detail: 'No affiliation found in the refreshed ALLCPR Inc. table. This does not establish who removed it or when.' };
      return this.classifyMatches(fresh, item);
    }
    return this.classifyMatches(matches, item);
  }

  classifyMatches(matches, item) {
    if (identityIssue(matches, item)) return {status:'MANUAL_REVIEW',detail:'ARC email matches, but the name differs from the source roster or is missing. Nothing selected or removed; manual review required.'};
    const instructors = matches.filter(row => row.role === 'Instructor');
    if (!instructors.length) return { status: 'MANUAL_REVIEW', detail: 'Only non-Instructor roles matched; these roles were preserved.' };
    return { status: 'READY', detail: instructors.length + ' Instructor affiliation(s): ALLCPR Inc.' };
  }

  async rowIsSelected(row, checkbox) {
    // aria-selected is diagnostic only: this site's table does not maintain it.
    return checkbox.isChecked();
  }

  async selectInstructorCheckbox(row) {
    await row.scrollIntoViewIfNeeded();
    const checkbox = row.getByRole('checkbox');
    if (await checkbox.count() !== 1) throw new Error('Expected exactly one checkbox on the target row.');
    if (await checkbox.isChecked()) return;
    const visual = row.locator('span.slds-checkbox_faux');
    if (await visual.count() !== 1) throw new Error('Target checkbox visual is missing or ambiguous.');
    await visual.click();
    await this.page.waitForTimeout(500);
    if (!await checkbox.isChecked()) throw new Error('Target checkbox did not remain selected. Remove was not clicked.');
  }

  async assertSelection(email, expectedCount, fullName) {
    const selected = await this.readSelections();
    if (selected.length !== expectedCount || selected.some(row =>
      row.cells[1] !== 'ALLCPR Inc.' ||
      row.cells[4]?.toLowerCase() !== email.toLowerCase() ||
      row.cells[6] !== 'Instructor' || (fullName !== undefined && normalizeName(row.cells[3]) !== normalizeName(fullName)))) {
      throw new Error('Selected rows do not match the exact authorized email / ALLCPR Inc. / Instructor set.');
    }
  }

  async readSelections() {
    // Locator pierces native shadow roots; querySelector on <tr> would miss
    // Lightning inputs in a native shadow DOM.
    return this.page.getByRole('grid').getByRole('checkbox').evaluateAll(inputs => inputs.filter(input => input.checked).map(input => {
      let row = input;
      while (row && row.tagName !== 'TR') row = row.parentElement || row.getRootNode()?.host;
      return { cells: row ? [...row.children].map(cell => (cell.textContent || '').trim().replace(/\s+/g, ' ')) : [] };
    }));
  }

  async unalign(item) {
    assertNotProtected(item, this.config);
    this.assertReady();
    if (!normalizeName(item.fullName)) return {status:'MANUAL_REVIEW',detail:'ARC source name is missing. No removal submitted.'};
    const matches = await this.freshMatches(item.email);
    if (matches.length && identityIssue(matches,item)) return this.classifyMatches(matches,item);
    const targets = matches.filter(row => row.role === 'Instructor');
    if (!targets.length) return this.inspect(item);
    const existingSelections = await this.readSelections();
    if (existingSelections.length) throw new Error('Existing checked rows detected before selecting the target. Start with an unselected table.');
    for (const target of targets) await this.selectInstructorCheckbox(target.row);
    await this.assertSelection(item.email, targets.length, item.fullName);
    const observer = observeAction(this.page, {
      platform: 'arclc',
      confirmDialog: this.config.runtime.confirmDialog,
      allowedConfirmMessages: this.config.sites.arclc.allowedConfirmMessages || []
    });
    const protectedRoles = matches.filter(row => row.role !== 'Instructor').map(row => row.role).sort();
    let result;
    let beforePath;
    try {
      const before = await this.saveDiagnostic('arclc-before-remove', { targetEmail: item.email, selectedInstructorCount: targets.length });
      beforePath = before.detailsPath;
      await this.assertSelection(item.email, targets.length, item.fullName);
      if (await visibleSessionProblem(this.page)) throw new Error('A session-expiry prompt appeared. Remove was not clicked. Sign in again and inspect.');
      await this.page.getByRole('button', { name: 'Remove Affiliation', exact: true }).click({ timeout: this.config.runtime.confirmDialog ? 0 : 30000 });
      await observer.settle();
      await this.page.waitForTimeout(1000);
      const settled = await observer.waitForQuiet();
      const after = await this.saveDiagnostic('arclc-after-remove', { targetEmail: item.email, events: observer.events });
      if (observer.sessionExpired || await visibleSessionProblem(this.page)) {
        result = { status: 'UNVERIFIED', detail: 'Session expired or access was restricted during submission; removal outcome is unknown. Sign in and inspect before resubmitting.' };
      } else if (observer.blocked) {
        result = { status: 'MANUAL_REVIEW', detail: 'Native dialog was dismissed; review its recorded text: ' + after.detailsPath };
      } else if (!settled) {
        result = { status: 'UNVERIFIED', detail: 'Removal requests did not finish; page preserved without reload. Details: ' + after.detailsPath };
      } else {
        const dialogs = await this.page.locator('[role="dialog"], [role="alertdialog"], section.slds-modal').filter({ visible: true }).allTextContents();
        if (dialogs.some(text => text.trim())) {
          result = { status: 'MANUAL_REVIEW', detail: 'Unrecognized DOM dialog after Remove. Details: ' + after.detailsPath };
        } else {
          // Every success requires refreshed, stable data and zero target Instructor rows.
          const deadline = Date.now() + (this.config.safety.verificationTimeoutMs || 45000);
          do {
            await this.page.waitForTimeout(1500);
            const remaining = await this.freshMatches(item.email);
            const others = remaining.filter(row => row.role !== 'Instructor').map(row => row.role).sort();
            if (JSON.stringify(others) !== JSON.stringify(protectedRoles)) {
              result = { status: 'MANUAL_REVIEW', detail: 'Non-Instructor affiliations changed during verification.' };
              break;
            }
            if (!remaining.some(row => row.role === 'Instructor')) {
              result = { status: 'REMOVED', detail: targets.length + ' Instructor affiliation(s) removed; refreshed ALLCPR table has zero target Instructor affiliations.' };
              break;
            }
          } while (Date.now() < deadline);
          result ||= { status: 'UNVERIFIED', detail: 'Remove was clicked, but target Instructor affiliation(s) remain after refreshed verification.' };
        }
      }
    } catch (error) {
      result = { status: 'UNVERIFIED', detail: error.message + ' Submission may have occurred. Sign in and inspect before resubmitting.' };
    } finally {
      await observer.stop();
    }
    const final = await this.saveDiagnostic('arclc-result', { targetEmail: item.email, result, events: observer.events, beforePath });
    return { ...result, detail: result.detail + ' Diagnostics: ' + final.detailsPath };
  }
}
