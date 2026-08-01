# Security policy

## Supported scope

`moodle-changefeed` supports read-only Moodle Web Service and optional ICS inputs. Moodle writes, assignment submissions, arbitrary function calls, redirect following, and access-control bypasses are unsupported. The local archive is the only bundled write target.

## Local sensitive data

Treat environment variables, private ICS URLs, the SQLite ledger and WAL files, cache and staging directories, downloaded course files, archive output, and debug logs as sensitive. Keep them outside repositories and shared folders. Use operating-system secret storage or a host credential provider where possible.

Public feed, plan, and receipt contracts redact credentials, download locators, source bodies, and absolute paths. Reports and examples must use anonymous fixtures. Never write a Moodle token to argv, configuration files, the ledger, logs, or issue reports.

## Reporting a vulnerability

Use GitHub's private security advisory flow for the repository. Include affected version, impact, and a minimal anonymous reproduction. Do not attach live tokens, private URLs, course files, ledger databases, or personal information. Allow maintainers time to investigate before public disclosure.

## Operational boundaries

- Verify the institution permits personal read-only API use.
- Use the minimum functions and bounded concurrency.
- Review items before delivery and require a fresh exact-plan confirmation.
- Back up a local ledger before migration; never overwrite an existing archive file silently.
- Revoke exposed tokens at the Moodle site and remove leaked copies from logs and shell history.

The maintainers cannot recover local data or credentials and do not operate a hosted service.
