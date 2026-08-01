import assert from "node:assert/strict";
import test from "node:test";

import { parseCli } from "../src/cli/parse.mjs";
import { invokeMoodleTool } from "../src/mcp/tools.mjs";
import { invokeRuntimeCommand } from "../src/runtime.mjs";

const FEED = {
  schemaVersion: 1,
  generatedAt: "2026-08-01T00:00:00.000Z",
  cursor: null,
  health: { status: "healthy", lastCompleteScanAt: "2026-08-01T00:00:00.000Z", scanComplete: true },
  counts: { total: 0, pending: 0, approved: 0 },
  items: []
};

test("CLI and MCP call the same feed facade and return the same contract", async () => {
  const calls = [];
  const runtime = {
    service: {
      async getFeed(input) {
        calls.push(structuredClone(input));
        return structuredClone(FEED);
      }
    }
  };
  const cli = parseCli(["feed", "--limit", "25", "--type", "assignment"]);
  const cliFeed = await invokeRuntimeCommand(runtime, cli.command, cli.input);
  const mcpFeed = await invokeMoodleTool(runtime, "get_moodle_change_feed", {
    limit: 25,
    type: "assignment"
  });

  assert.deepEqual(cliFeed, mcpFeed);
  assert.deepEqual(calls, [
    { limit: 25, type: "assignment" },
    { limit: 25, type: "assignment" }
  ]);
});
