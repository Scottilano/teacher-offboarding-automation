# Security and Data Handling

Use this app only for company-authorized ALLCPR instructor offboarding. Importing a roster is not execution authorization. A person must verify the identities and exclude teachers who should not be unaligned. Code cannot guarantee source roster accuracy or external website correctness.

Never commit config.json, .runtime.local.json, .env, secrets, data, reports, plans, browser sessions, real CSV/XLSX files, passwords, tokens, or service-account private keys. Browser profiles contain sensitive sessions and must be protected like passwords. Reports and diagnostics may contain names and emails; store them only in company-approved locations.

Distribute the allowlisted output from npm run export:source. The scanner is not a complete secret-detection system; manual review remains required. Do not upload the original working folder or use git add -f to override exclusions. A .gitignore cannot remove already committed data or Git history.

Unknown dialogs, changed organizations or roles, mismatched names, expired sessions, incomplete data, and failed evidence persistence must stop processing. Never bypass these checks. Deferral is not success and does not undo a possible earlier submission.

The service binds to 127.0.0.1 and validates the local token, Origin and Host. Do not expose it to the public internet or through a tunnel. Do not let multiple people execute actions using the same browser profile.

Contact the company maintainer privately about security incidents. Do not include teacher data, diagnostic files, profiles, or credentials in public issues.
