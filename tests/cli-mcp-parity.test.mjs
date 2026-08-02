import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseCli } from "../src/cli/parse.mjs";
import { runCli } from "../src/cli/main.mjs";
import { createMoodleChangefeedMcpServer } from "../src/mcp/server.mjs";
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

const TEMPORARILY_UNREACHABLE = Object.freeze({
  schemaVersion: 1,
  status: "temporarily_unreachable",
  message: "暂时无法连接学校 Moodle，请稍后重试",
  canScan: false,
  checkedAt: "2026-08-02T00:00:00.000Z"
});

const SITE_URL_REQUIRED = Object.freeze({
  schemaVersion: 1,
  status: "site_url_required",
  message: "请输入学校 Moodle 地址",
  canScan: false,
  checkedAt: null
});

const COMPATIBLE = Object.freeze({
  schemaVersion: 1,
  status: "compatible",
  message: "Moodle 已连接，可开始同步",
  canScan: true,
  checkedAt: "2026-08-02T00:00:00.000Z"
});

test("CLI sync closes with the connection before creating a runtime", async () => {
  let output = "";
  const result = await runCli({
    argv: ["sync", "--site-url", "https://moodle.example.edu"],
    env: { MOODLE_CHANGEFEED_SITE_URL: "https://moodle.example.edu" },
    output: {
      isTTY: false,
      write(chunk) {
        output += String(chunk);
      }
    },
    probeEntry: async () => TEMPORARILY_UNREACHABLE,
    createRuntime() {
      throw new Error("unscannable sync must not create SQLite or a runtime");
    }
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    connection: TEMPORARILY_UNREACHABLE
  });
  assert.equal(output, `${JSON.stringify(result)}\n`);
});

test("CLI sync probes a missing site before enforcing runtime configuration", async () => {
  let output = "";
  const result = await runCli({
    argv: ["sync"],
    env: {},
    output: {
      isTTY: false,
      write(chunk) {
        output += String(chunk);
      }
    },
    probeEntry: async ({ siteUrl }) => {
      assert.equal(siteUrl, null);
      return SITE_URL_REQUIRED;
    },
    createRuntime() {
      throw new Error("a missing site must close before runtime creation");
    }
  });

  assert.deepEqual(result, { schemaVersion: 1, connection: SITE_URL_REQUIRED });
  assert.equal(output, `${JSON.stringify(result)}\n`);
});

test("CLI sync treats an invalid overridden environment site as unbound", async () => {
  let output = "";
  let probeCalls = 0;
  const result = await runCli({
    argv: ["sync", "--site-url", "https://moodle.example.edu"],
    env: {
      MOODLE_CHANGEFEED_SITE_URL: "not-a-valid-site",
      MOODLE_CHANGEFEED_TOKEN: "fixture-secret"
    },
    output: {
      isTTY: false,
      write(chunk) {
        output += String(chunk);
      }
    },
    probeEntry: async ({ siteUrl, credentialProvider }) => {
      probeCalls += 1;
      assert.equal(siteUrl, "https://moodle.example.edu");
      assert.equal(credentialProvider?.siteKey ?? null, null);
      assert.equal(await credentialProvider?.getWebServiceToken?.() ?? null, null);
      return TEMPORARILY_UNREACHABLE;
    },
    createRuntime() {
      throw new Error("unbound sync must close before runtime creation");
    }
  });

  assert.equal(probeCalls, 1);
  assert.deepEqual(result, {
    schemaVersion: 1,
    connection: TEMPORARILY_UNREACHABLE
  });
  assert.doesNotMatch(output, /fixture-secret|not-a-valid-site/);
});

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

test("CLI and MCP bootstrap return the same entry connection fixture", async () => {
  const siteUrl = "https://moodle.example.edu/learn";
  const cli = await runCli({
    argv: ["bootstrap", "--site-url", siteUrl],
    env: { MOODLE_CHANGEFEED_SITE_URL: siteUrl },
    output: { isTTY: false, write() {} },
    probeEntry: async () => structuredClone(COMPATIBLE)
  });

  const server = createMoodleChangefeedMcpServer({
    publicConfig: {
      siteUrl,
      writeEnabled: false,
      credentialStatus: { webServiceToken: "missing", icsUrl: "missing" }
    },
    probeEntry: async () => structuredClone(COMPATIBLE),
    createRuntime: async () => ({
      service: {
        getStatus: async () => ({
          health: { status: "not_scanned", lastCompleteScanAt: null, scanComplete: false },
          counts: { total: 0, pending: 0, approved: 0 },
          objectCount: 0,
          resourceCount: 0
        })
      },
      close() {}
    })
  });
  const client = new Client({ name: "moodle-changefeed-parity-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "agent_bootstrap",
      arguments: { siteUrl }
    });
    const mcp = JSON.parse(result.content.find(({ type }) => type === "text")?.text || "{}");

    assert.deepEqual(mcp.connection, cli.connection);
  } finally {
    await client.close();
    await server.close();
  }
});
