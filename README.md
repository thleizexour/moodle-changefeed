# moodle-changefeed

Local-first Moodle change detection and human-in-the-loop delivery for agents.

## Problem

Moodle data is useful to agents, but raw page scraping, repeated model parsing, guessed file URLs, and direct target writes are brittle. This package turns read-only Moodle inputs into deterministic changes, versioned review items, verified resource bytes, and confirmation-bound delivery receipts.

## 60-second anonymous demo

No Moodle account or environment variables are needed. Inspect the interface with `node src/cli/main.mjs --help`, then run the complete synthetic baseline/change/review/archive flow with `node src/cli/main.mjs demo --fixture anonymous/basic`.

The demo returns five counters and deletes its temporary runtime data. It never reads the configured data directory.

## Architecture

The public core is one Node.js ESM package:

    read-only Moodle adapter -> canonical snapshot -> deterministic diff
    -> SQLite review ledger -> bounded CLI/MCP -> confirmed delivery adapter

CLI and MCP call the same runtime façade. Stable IDs, cursors, plan hashes, cache verification, and optimistic review transitions are implemented in code rather than prompts.

## Connect a Moodle site

The user-visible onboarding sequence is: enter the Moodle site, authorize with the institution when prompted, receive the connected message, then scan.

1. Enter the site:

   ```text
   moodle-changefeed bootstrap --site-url https://moodle.example.edu
   ```

2. Complete the institution's authorization flow through the host integration, then run the same command again. The host owns credential acquisition and storage; this command never accepts a password or token in argv.
3. After the command reports that the site is connected, run `moodle-changefeed sync`.

## CLI

Set non-secret configuration with `MOODLE_CHANGEFEED_SITE_URL`, `MOODLE_CHANGEFEED_DATA_DIR`, and `MOODLE_CHANGEFEED_ARCHIVE_ROOT`. The host completes authorization and supplies the site-bound Web Service token through its credential provider or `MOODLE_CHANGEFEED_TOKEN`; an optional private calendar URL uses `MOODLE_CHANGEFEED_ICS_URL`. The CLI rejects Moodle secrets in argv.

Run `moodle-changefeed bootstrap`, then `moodle-changefeed sync`, `moodle-changefeed feed`, and `moodle-changefeed status`. Use `moodle-changefeed --help` for the bounded review, cache, and delivery arguments.

`sync` returns only health and aggregate change counts. Per-item course and resource details remain behind the bounded, paginated `feed` and `review show` commands.

Target writes remain disabled unless `MOODLE_CHANGEFEED_WRITE_ENABLED=true`. Interactive delivery displays the plan and requires the exact plan hash. Non-interactive delivery requires a host confirmation provider.

### Bootstrap API contract

Automation should route on `connection.canScan`, not on prose or a guessed Moodle version. `authorization_required` has `canScan=false`; `compatible` and `compatible_no_courses` have `canScan=true`. Call scan only when `canScan` is true.

Optional source features are checked lazily. An operation-level `capability_unavailable` error limits only that optional feature; callers may continue using unrelated available capabilities. It does not make an otherwise compatible site unsupported.

## MCP configuration

The stdio entry is `src/mcp/server.mjs` in a source checkout or the exported `moodle-changefeed/mcp` entry after installation. A generic client configuration is:

```json
{
  "mcpServers": {
    "moodle-changefeed": {
      "command": "node",
      "args": ["/path/to/node_modules/moodle-changefeed/src/mcp/server.mjs"],
      "env": {
        "MOODLE_CHANGEFEED_SITE_URL": "https://moodle.example.edu"
      }
    }
  }
}
```

Keep secrets in the client's secret environment facility, not in committed configuration. New agents should call `agent_bootstrap`, then `list_moodle_changefeed_capabilities`. The standalone MCP can preview delivery but cannot mint its own confirmation.

## Source capability matrix

| Capability | Required | Behavior |
|---|---:|---|
| Site info, enrolled courses, course contents | Yes | Read-only Moodle Web Service baseline |
| Assignments, announcements, calendar, quizzes | Optional | Degraded health when unavailable |
| Private ICS feed | Optional | Read-only deadline supplement |
| Arbitrary Web Service functions | No | Rejected by an allowlist |
| Moodle writes or submissions | No | Unsupported |

Compatibility is declared by available Web Service functions, not by an unverified Moodle version number. A site administrator may disable Mobile/Web Services or individual functions.

## Review and confirmation model

The first complete sync creates a baseline and no review items. Later changes enter a paginated feed. Review decisions use expected versions; conflicts require a fresh read. Approval changes local state only.

Delivery is a separate boundary: prepare a closed plan, show its exact hash and operations, then obtain a short-lived single-use confirmation bound to the review versions, resource hashes, adapter fingerprint, and expiry. Re-prepare after any evidence changes.

## Local archive

The default adapter writes verified cache bytes into sanitized logical segments such as term, course, item type, item title, and attachments. It uses no-overwrite atomic publication and refuses unknown existing files. Receipts expose opaque refs rather than absolute paths.

## Custom adapter

Implement `id`, `fingerprint()`, `plan()`, and `execute()`; never put target credentials into a plan or receipt. See `examples/custom-adapter/index.mjs`. Run it with `node examples/custom-adapter/index.mjs`.

## Privacy and compliance limits

This project processes data available to the authenticated user and does not bypass site access controls. Users must follow their institution's Moodle policy, course rules, data-retention requirements, and applicable law. This is not legal advice.

Tokens, private ICS URLs, downloaded course files, the ledger, cache, logs, and archive output are local sensitive data. Do not commit or redistribute course materials without permission. The package does not submit assignments, modify Moodle, evade rate limits, or make public sharing decisions.

## Development

Requires Node.js 22 or newer. Run `npm ci`, `npm test`, `npm run demo`, `npm run audit:public`, and `npm run verify:release`. Tests use anonymous fixtures and need no repository secrets.

## Roadmap

- Validate more Moodle capability combinations and self-hosted deployments.
- Publish adapter examples for other local knowledge bases.
- Add signed release provenance after the private release candidate is stable.
- Consider public release only after privacy and real-source verification.
