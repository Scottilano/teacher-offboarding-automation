# Teacher Offboarding — ALLCPR

A local desktop-browser app for reviewing departed-teacher rosters and removing instructor affiliations from **ARCLC** and **AHA Atlas**. Import a CSV or Excel file, exclude anyone who should remain affiliated, sign in, authorize a batch, and export verified results.

The app runs local code and Playwright; it does not call an LLM. Local-file mode does not require Google credentials or update your spreadsheet. Names and emails are entered into the selected official platform as needed for matching; rosters, jobs, reports, and browser sessions are stored on your computer.

## Scope and safety

This is an internal ALLCPR tool, not a general-purpose removal tool for arbitrary organizations.

- **ARCLC:** ALLCPR Inc., Instructor affiliations only.
- **AHA:** ALLCPR, organization 32238, Instructor role; verified BLS and Heartsaver workflows.
- Exact email and source-name checks, fresh login checks, and post-action verification remain mandatory.
- Unknown dialogs, identity conflicts, incomplete data, expired sessions, or uncertain results stop the batch.
- Removing an affiliation is not the same as deleting a teacher account. Other roles and organizations must remain untouched.
- Code cannot guarantee that a source roster or an external website is always correct. A person must review the roster and authorize execution.

## 1. Install

Requirements: **Node.js 22+**, **Python 3.10+** (3.12 recommended), and the Chromium version supplied by Playwright. Use the Node version in `.nvmrc` where possible.

From the repository root on macOS or Linux:

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run browsers:install
npm run init
npm run doctor
npm test
npm run test:browser
npm start
```

On Windows, replace the two Python setup commands with:

```powershell
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The remaining npm commands are the same. Windows end-to-end operation has not yet been accepted. The macOS `.command` launchers and **Show in Finder** feature are macOS-only.

On Linux, missing browser system libraries can be installed with `npm run browsers:install -- --with-deps`; administrator privileges may be required. Headless tests can run without a desktop, but real interactive login requires a graphical session.

`npm run init` creates `config.json` only if it is missing. It never overwrites existing settings. The app opens automatically on macOS; on other systems, open the local URL printed in the terminal. Keep that terminal open and do not share the URL, which includes a local session token.

### Runtime selection

Python selection order: `OFFBOARDING_PYTHON` → project `.venv` → `python3` on PATH (Windows: `python`). Node normally comes from the shell; `OFFBOARDING_NODE` can override it. An optional ignored `.runtime.local.json` can supply local `node` and `python` paths for the launchers. Do not distribute that file. The app does not automatically load `.env`.

## 2. Prepare a roster

Export a Google Sheet as CSV or .xlsx; no Google service account is needed. The first row must contain **Full Name** and **Email**. For example:

```csv
Full Name,Email
Example Teacher,teacher@example.com
Another Teacher,another@example.com
```

Status columns are ignored: every included teacher is treated as someone you intend to offboard. Repeated records are merged by email. Conflicting names for one email, invalid emails, missing identities, or formulas in identity fields must be corrected before saving.

Default file limit: **50 MB**. Maximum: **10,000 rows including the header, 100 columns**. For a workbook with multiple worksheets, choose one explicitly. Worksheets are not automatically combined. Recognized Chinese column headers and international names remain supported, even though the app interface is English.

## 3. Use the app

1. **Read Roster:** select the file under **Import and Review** and click **Read Roster**. If prompted, select a worksheet and click **Read Worksheet**.
2. **Review and exclude:** check names, emails, counts, and validation results. Click **Exclude from Job** for anyone who should not be removed. **Include in Job** reverses that choice before saving. Search filters the display only; it does not change the processing scope.
3. **Save Local Job:** choose ARCLC, AHA, or both, then save. Saving does not log in or remove anyone. Exclusions apply across selected platforms for this job only; new imports require a new review.
4. **Check Login:** click **Check Login / Open ARCLC** or **Check Login / Open AHA**. Sign in on the official page opened by the app, including MFA. Return and click the same button again to verify the session. Login from your normal browser is not shared.
5. **Inspect if needed:** click **Inspect Unfinished Items (No Removal)** for read-only checking. New installations default to inspection-only until an administrator completes acceptance.
6. **Authorize and execute:** review the saved scope, choose a batch size, check the authorization box, and click **Execute Next Batch**. The default is **10**, with a maximum of **100 platform actions**. One teacher on two platforms counts as two actions. Actions are sequential, not parallel.
7. **Review each batch:** inspect the results. Authorization clears after each batch and must be renewed. Do not navigate, switch organizations, select other teachers, or close the automated browser during execution.
8. **Export:** click **Export Results CSV**. The app displays the saved path; on macOS click **Show in Finder** to locate it.

To stop, click **Stop After Current Teacher**. The current action finishes verification before the next teacher is skipped. To quit the app, press **Ctrl+C** in its terminal and wait for shutdown.

## 4. Handle a pause or resume a job

Under **Resume a local job**, select a saved job and click **Open Job**. Verified completed actions are skipped only within that same job.

If login expires, sign in again, verify the session, inspect unfinished items, and authorize a new batch. Login alone does not resume execution. For an unknown outcome, check the official website and inspect again before retrying; never assume a timed-out removal failed.

Use **Defer This Item** only after reviewing an unresolved result. Enter a reason, check the separate confirmation, and click **Confirm Deferral**. This skips one platform action in one job, retains the previous result and audit, and does **not** count as success. It does not undo an earlier submission or exclude the teacher from future imports.

Old job details, operator-entered text, and historical audit records retain their original language and contents. Switching the UI to English does not rewrite them.

## Result guide

| Result | Meaning |
| --- | --- |
| Pending | Not processed yet. |
| Ready | Inspected; no removal submitted yet. |
| Removed | Removal submitted and verified with refreshed data. |
| Verified absent | Fresh scoped checks found no target affiliation; does not establish who removed it or when. |
| Manual review / Error / Unverified / Interrupted | Not successful; investigate and inspect before retrying. |
| Sign-in required | Session check failed; sign in and recheck. |
| Deferred for manual review | Intentionally skipped for this job/platform; not counted as complete. |
| EXCLUDED in CSV | Excluded at import; never queued for inspection or removal. |

## Administrator: enable a new installation

The distributed template uses `implementationStatus: "discovery_complete"` and AHA `coverageVerified: false`. It cannot submit removals. Passing simulated tests is not live website acceptance.

An authorized administrator should verify company scope, roles, identity matching, and AHA All/Active/Expired coverage. For an explicitly authorized single-person acceptance test, set that platform to `implementationStatus: "ready"` in local `config.json`. Enable AHA `coverageVerified` only after validating the coverage. For ARC, `allowedConfirmMessages` must contain only the exact official confirmation text reviewed for this workflow; never approve unknown text.

Restart, import only the authorized test teacher, set the batch size to 1, and verify the website and saved results before increasing the batch. Do not ship live accounts, profiles, or historical acceptance records as defaults. Keep these company-specific safety boundaries intact.

## Configuration and storage

- `import.maxFileMb`: 1–100, default 50.
- `safety.maxExecuteActions`: overall batch limit, currently 100.
- `sites.<platform>.maxBatchActions`: optional lower platform limit.
- Restart after configuration changes. A page refresh does not reload server configuration.

All paths follow the current installation directory:

| Path | Contents |
| --- | --- |
| `data/local-jobs` | Saved jobs, roster snapshots, exclusions, and progress |
| `data/browser-profiles` | Sensitive login sessions; protect like passwords |
| `reports/audit/events.jsonl` | Durable action and deferral audit |
| `reports/verification` | AHA per-view verification evidence |
| `reports/diagnostics` | Diagnostic screenshots and details |
| `reports/results` | Exported results CSVs |

AHA evidence records completed, failed, and unvisited status views. The CSV **Evidence File** column links a result to its local evidence path. Historical evidence is never invented or backfilled.

See [LOCAL-APP.md](LOCAL-APP.md) for the operator checklist and troubleshooting, and [SECURITY.md](SECURITY.md) for handling sensitive data.

## Tests and distribution

`npm test` runs synthetic logic, import, localhost API, and safety tests. `npm run test:browser` uses intercepted, simulated pages, not real teachers. `npm run doctor` checks dependencies and browser files; it does not prove that a browser can launch or that a website workflow is accepted.

A macOS/Linux GitHub Actions workflow is included. CI must actually run before it can be considered passed; Windows full-flow acceptance remains outstanding.

Run `npm run export:source` to generate a clean `dist/company-repo-*` folder. Review and commit its contents to the private company repository—not the original working folder. The export excludes local configuration, sessions, rosters, historical reports, runtime overrides, and old live-test scripts. Its scanner is an additional safeguard, not a complete secret audit.

No repository is created or pushed automatically. The code has no open-source license grant; distribution is governed by company policy. Legacy Google Sheets CLI commands remain for compatibility only and require separate credentials; local-file mode does not use them.
