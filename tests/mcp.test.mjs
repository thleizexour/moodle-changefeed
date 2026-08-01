import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMoodleChangefeedMcpServer } from "../src/mcp/server.mjs";

const TOOL_NAMES = [
  "agent_bootstrap",
  "cache_moodle_resources",
  "deliver_moodle_batch",
  "get_moodle_change_feed",
  "get_moodle_pipeline_status",
  "get_moodle_review_item",
  "list_moodle_changefeed_capabilities",
  "prepare_moodle_delivery",
  "scan_moodle_changes",
  "set_moodle_review_decision"
].sort();

function runtime() {
  return {
    config: { writeEnabled: false },
    service: {
      getStatus: async () => ({
        schemaVersion: 1,
        health: { status: "not_scanned", lastScanAt: null, lastCompleteScanAt: null },
        counts: { total: 0, pending: 0, approved: 0 },
        objectCount: 0,
        resourceCount: 0
      })
    },
    coordinator: {},
    close() {}
  };
}

test("standalone MCP exposes only ten bounded tools", async () => {
  const server = createMoodleChangefeedMcpServer({
    createRuntime: async () => runtime(),
    publicConfig: {
      siteUrl: "https://moodle.example.edu",
      writeEnabled: false,
      credentialStatus: { webServiceToken: "configured", icsUrl: "missing" }
    }
  });
  const client = new Client({ name: "moodle-changefeed-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map(({ name }) => name).sort(), TOOL_NAMES);
    const delivery = result.tools.find(({ name }) => name === "deliver_moodle_batch");
    assert.deepEqual(delivery.inputSchema.required.sort(), ["confirmationToken", "planHash"]);

    const bootstrap = await client.callTool({ name: "agent_bootstrap", arguments: {} });
    const bootstrapText = bootstrap.content.find(({ type }) => type === "text")?.text || "";
    assert.match(bootstrapText, /"schemaVersion":1/);
    assert.match(bootstrapText, /list_moodle_changefeed_capabilities/);
    assert.doesNotMatch(bootstrapText, /\/Users\/|private-token|webservice\/pluginfile/);

    const capabilities = await client.callTool({
      name: "list_moodle_changefeed_capabilities",
      arguments: { limit: 5 }
    });
    const capabilityText = capabilities.content.find(({ type }) => type === "text")?.text || "";
    assert.match(capabilityText, /confirmed_external_write/);
    assert.match(capabilityText, /"nextCursor":null/);
    assert.doesNotMatch(capabilityText, /\/Users\//);
  } finally {
    await client.close();
    await server.close();
  }
});

test("standalone stdio entry starts without private host configuration", async () => {
  const client = new Client({ name: "moodle-changefeed-stdio-test", version: "1.0.0" });
  const nodeExecutable = existsSync("/usr/local/bin/node")
    ? "/usr/local/bin/node"
    : process.execPath;
  const transport = new StdioClientTransport({
    command: nodeExecutable,
    args: ["src/mcp/server.mjs"],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {}
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.deepEqual(result.tools.map(({ name }) => name).sort(), TOOL_NAMES);
  } finally {
    await client.close();
  }
});
