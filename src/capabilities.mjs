const CAPABILITY_GROUPS = Object.freeze([
  {
    id: "source",
    description: "Read Moodle through bounded, read-only adapters and update the local ledger.",
    tools: [
      { name: "scan_moodle_changes", effect: "external_read", command: "sync" }
    ]
  },
  {
    id: "changefeed",
    description: "Read compact, stable, paginated change contracts.",
    tools: [
      { name: "get_moodle_change_feed", effect: "external_read", command: "feed" },
      { name: "get_moodle_pipeline_status", effect: "external_read", command: "status" }
    ]
  },
  {
    id: "review",
    description: "Inspect and decide local review items with optimistic versions.",
    tools: [
      { name: "get_moodle_review_item", effect: "external_read", command: "review show" },
      { name: "set_moodle_review_decision", effect: "local_state_write", command: "review decide" }
    ]
  },
  {
    id: "cache",
    description: "Download verified resources into a content-addressed local cache.",
    tools: [
      { name: "cache_moodle_resources", effect: "local_state_write", command: "cache" }
    ]
  },
  {
    id: "delivery",
    description: "Preview delivery, then execute only with host-owned confirmation.",
    tools: [
      { name: "prepare_moodle_delivery", effect: "preview", command: "delivery prepare" },
      { name: "deliver_moodle_batch", effect: "confirmed_external_write", command: "delivery execute" }
    ]
  }
]);

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, offset }), "utf8").toString("base64url");
}
function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null) return 0;
  try {
    if (typeof cursor !== "string" || cursor.length > 128 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error();
    }
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      parsed?.schemaVersion !== 1 ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0 ||
      encodeCursor(parsed.offset) !== cursor
    ) {
      throw new Error();
    }
    return parsed.offset;
  } catch {
    throw new TypeError("Invalid capability cursor");
  }
}

export function listMoodleChangefeedCapabilities({ group, cursor, limit = 5 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) {
    throw new TypeError("Capability limit must be 1-5");
  }
  const selected = group
    ? CAPABILITY_GROUPS.filter(({ id }) => id === group)
    : [...CAPABILITY_GROUPS];
  if (group && selected.length === 0) throw new TypeError("Unknown capability group");
  const offset = decodeCursor(cursor);
  if (offset > selected.length) throw new TypeError("Capability cursor is out of range");
  const groups = selected.slice(offset, offset + limit);
  const nextOffset = offset + groups.length;
  return {
    schemaVersion: 1,
    groups,
    nextCursor: nextOffset < selected.length ? encodeCursor(nextOffset) : null
  };
}

export async function buildMoodleAgentBootstrap({ publicConfig, runtime }) {
  const status = runtime
    ? await runtime.service.getStatus()
    : {
        health: { status: "not_configured", lastCompleteScanAt: null, scanComplete: false },
        counts: { total: 0, pending: 0, approved: 0 },
        objectCount: 0,
        resourceCount: 0
      };
  return {
    schemaVersion: 1,
    package: { name: "moodle-changefeed", version: "0.1.0-dev.0" },
    health: status.health,
    counts: status.counts,
    objectCount: status.objectCount,
    resourceCount: status.resourceCount,
    safety: {
      sourceMode: "read_only",
      writeEnabled: Boolean(publicConfig?.writeEnabled),
      confirmation: "host_provider_required"
    },
    configuration: {
      siteUrl: publicConfig?.siteUrl ? "configured" : "missing",
      webServiceToken: publicConfig?.credentialStatus?.webServiceToken || "unknown",
      icsUrl: publicConfig?.credentialStatus?.icsUrl || "unknown"
    },
    routing: {
      capabilities: "list_moodle_changefeed_capabilities",
      firstRead: "get_moodle_pipeline_status",
      firstSync: "scan_moodle_changes"
    },
    commandHints: {
      demo: "moodle-changefeed demo --fixture anonymous/basic",
      bootstrap: "moodle-changefeed bootstrap"
    }
  };
}
