---
name: moodle-changefeed
description: Use when an agent must inspect Moodle changes, review assignments or resources, cache attachments, or prepare and deliver a local archive through moodle-changefeed CLI or MCP.
---

# Moodle Changefeed

## Overview

Use stable MCP tools instead of parsing Moodle pages, opening the ledger, or inventing input fields. Treat Moodle as read-only input and require human review before delivery.

## Connection onboarding

The user-visible sequence is: ask for the Moodle site, let the user authorize, show the connected message, then scan.

1. Run `moodle-changefeed bootstrap --site-url https://moodle.example.edu` for the requested site.
2. Read the returned `connection.canScan` gate.
3. When `connection.canScan` is false, the complete user-facing response is `connection.message`. Stop there: do not add machine fields and do not call scan.
4. When `connection.canScan` is true, show `connection.message` and continue to scan.

## API routing

- `authorization_required` is a machine status with `canScan=false`.
- `compatible` and `compatible_no_courses` are machine statuses with `canScan=true`.
- `capability_unavailable` is an operation-level limitation for an optional feature. Report that feature as unavailable and continue unrelated available capabilities; do not reinterpret it as whole-site incompatibility.

## Changefeed workflow

1. Call `agent_bootstrap` with `{}` after the connection gate is open.
2. Call `list_moodle_changefeed_capabilities` for only the relevant group. Use the returned tool names and inspect their schemas; do not guess arguments.
3. Call `get_moodle_pipeline_status`, then `scan_moodle_changes`. A read-only scan updates local evidence; it is not a confirmed delivery to Feishu or another target.
4. Read `get_moodle_change_feed` in bounded pages. Follow each returned cursor until it is null. If scan health is incomplete or degraded, report that scope and never infer missing items.
5. Read selected items with `get_moodle_review_item`. Present course, change kind, due date, priority signals, and resource refs for human review.
6. Apply the human's decision with `set_moodle_review_decision` and the item's current version. On a version conflict, re-read the item and ask again if the evidence changed.
7. Cache approved resources by stable ID with `cache_moodle_resources`. Never pass a URL or output path.
8. Call `prepare_moodle_delivery` for approved items. Present its plan hash, counts, logical archive segments, and expiry.
9. Stop for fresh confirmation. Call `deliver_moodle_batch` only with a host-issued token bound to that exact plan. Earlier blanket authorization is not confirmation for a new plan.

## Quick reference

| Need | Tool | Boundary |
|---|---|---|
| Site entry | `moodle-changefeed bootstrap --site-url ...` | Anonymous or site-bound read |
| Health and routing | `agent_bootstrap` | Local read |
| Capability names | `list_moodle_changefeed_capabilities` | Local read |
| Fresh source data | `scan_moodle_changes` | External read + local ledger |
| Review queue | `get_moodle_change_feed` | Paginated local read |
| Decision | `set_moodle_review_decision` | Versioned local write |
| Verified bytes | `cache_moodle_resources` | Bounded external read |
| Preview | `prepare_moodle_delivery` | No target write |
| Delivery | `deliver_moodle_batch` | Exact-plan confirmation required |

## Recovery

- For an invalid cursor, restart the feed read and deduplicate by stable item ID.
- For a partial scan, keep the last complete baseline and report degraded health.
- For a stale or expired plan, prepare a new plan and obtain new confirmation.
- If MCP is unavailable, run `moodle-changefeed --help`; use documented CLI arguments only.

## Common mistakes

- Caching is not delivery. Use the delivery preview for the archive target.
- Approval is not delivery confirmation. They are separate human decisions.
- Resource refs are opaque. Never reconstruct download URLs or local paths.
