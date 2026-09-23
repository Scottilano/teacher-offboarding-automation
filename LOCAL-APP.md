# Operator Guide

## Before you begin

- Start with `npm start` (macOS also supports `start.command`).
- On a new installation, follow README setup and administrator acceptance first.
- Use a reviewed roster, not an unverified HR export. Status columns do not filter the list.
- Keep the app terminal open. Do not share its session URL.
- Enter passwords and MFA only on the official platform pages opened by the app.

## Import checklist

1. Export a sheet as .xlsx or CSV. Include Full Name and Email in the header.
2. Click Read Roster; select the correct worksheet if asked.
3. Resolve all invalid identities and same-email name conflicts in the source file, then import again.
4. Use Exclude from Job for anyone who should remain affiliated. Include in Job reverses a choice before saving.
5. Review Show excluded only, the counts, and selected platforms. Search changes visibility only.
6. Save Local Job. This does not submit a removal.

Exclusions apply to all selected platforms within the saved job, not future imports. A saved job is an immutable roster snapshot; create a new job to change its membership. An entirely excluded roster cannot be saved.

## Sign in and process

Use Check Login / Open ARCLC and/or Check Login / Open AHA. Complete sign-in in each separate automated browser, then click Check Login again.

Inspect Unfinished Items is read-only. To execute, review the pending identities, set 1–100 platform actions per batch (default 10), check the authorization box, and click Execute Next Batch. A teacher processed on both platforms counts twice. The current queue processes ARC before AHA.

The app checks login before each teacher, performs one action at a time, and verifies the result. It does not guarantee that input data or external website data is correct. Do not change pages, organizations, or selections while it runs.

After each batch, review every result and authorize again. Stop After Current Teacher waits for current verification and does not start the next teacher. Ctrl+C requests safe shutdown.

## Pauses and recovery

- **Expired session:** sign in, verify login, inspect unfinished items, then authorize again.
- **Unverified / Interrupted:** a submission may have occurred. Inspect the site and refresh the result before retrying; do not blindly resubmit.
- **Identity conflict / other role:** verify the source identity. Administrator or other non-Instructor roles must remain untouched.
- **Defer This Item:** enter a reason and explicitly confirm. The original result and audit remain. Deferral skips only that job/platform, is not success, and cannot undo a submission.
- **Resume later:** select the saved job and click Open Job. Completed actions are skipped within that job. New jobs always inspect current website state.

Older saved details remain in their original language. The English interface does not rewrite historical evidence, user-entered reasons, names, or source data.

## Exports and evidence

Export Results CSV saves under `reports/results`. Show in Finder is available on macOS after export. Other systems can use the displayed path.

AHA verification saves All, Active, and Expired view evidence under `reports/verification`, with failure and not-checked states explicitly recorded. The Evidence File column identifies the file. ARC diagnostics include the rendered-table coverage evidence for removal verification.

A successful result requires refreshed scoped checks. ARC scans the visible nonpaginated list to its end and checks stable rows, declared totals where available, loading indicators, and observed request completion. Pagination, virtualized row replacement, failed requests, or incomplete data block an absence conclusion. This is observable website evidence, not an absolute guarantee of backend completeness.

## Limits

Default file limit is 50 MB, configurable through `import.maxFileMb` (1–100). Maximum worksheet size is 10000 rows including the header and 100 columns. Supported formats: .xlsx, UTF-8 CSV with optional BOM, and BOM-marked UTF-16 CSV. Legacy .xls, encrypted workbooks, macros, and arbitrary online URLs are unsupported.

The decompressed XLSX and extracted output limits are each four times the file cap (default 200 MB). Parsing times out after 60 seconds. ZIP archives are limited to 2000 entries, CSV fields to 32768 characters. Identity formulas and XML entity declarations are rejected. A file below 50 MB can still exceed these structural limits.

The overall batch cap is `safety.maxExecuteActions`; a platform can impose a lower `maxBatchActions`. Larger batches reduce reauthorization frequency, not per-teacher verification or sequential execution.

## Troubleshooting

| Issue | What to do |
| --- | --- |
| App already running | Use its existing window, or quit its terminal with Ctrl+C before restarting. |
| Missing Node / Python / openpyxl / Chromium | Run npm run doctor and follow the README installation steps. |
| Cannot save roster | Fix rejected records; ensure at least one teacher remains included. |
| Execute disabled | Read the explanation beside the button: session, scope, acceptance, unresolved results, or authorization may be missing. |
| Setting did not change | Restart the server; refreshing the page alone does not reload config.json. |
| Browser test cannot launch Chromium | Keep the error details; run in a normal desktop terminal or CI. A launch failure is not a passing UI test. |
| Audit or evidence cannot be saved | Restore local disk access/space, inspect the website outcome, then recover the job. Never assume a removal failed. |

For repository setup, administrator enablement and publishing, see README.md. Protect profiles and reports as described in SECURITY.md.
