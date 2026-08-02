#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createEnvironmentCredentialProvider,
  loadEntryPublicConfig
} from "../config.mjs";
import { probeMoodleEntry } from "../entry-probe.mjs";
import { createStandaloneRuntime } from "../runtime.mjs";
import { registerMoodleChangefeedTools } from "./tools.mjs";

export function createMoodleChangefeedMcpServer({
  createRuntime,
  publicConfig,
  probeEntry,
  defaultSiteUrl = null
}) {
  const server = new McpServer(
    { name: "moodle-changefeed", version: "0.1.0-dev.0" },
    {
      instructions:
        "Call agent_bootstrap first. Moodle is read-only input; review writes only local state. Delivery requires a prepared plan and host-owned confirmation."
    }
  );
  registerMoodleChangefeedTools({
    server,
    createRuntime,
    publicConfig,
    probeEntry,
    defaultSiteUrl
  });
  return server;
}
export async function startMoodleChangefeedStdio({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  transport = new StdioServerTransport()
} = {}) {
  const { publicConfig, requestedSiteUrl } = loadEntryPublicConfig({ argv, env, cwd });
  let credentialProvider;
  try {
    credentialProvider = publicConfig.siteUrl
      ? createEnvironmentCredentialProvider(env)
      : null;
  } catch (error) {
    if (!(error instanceof TypeError) || !/^Moodle site\b/.test(String(error.message))) {
      throw error;
    }
    credentialProvider = null;
  }
  const server = createMoodleChangefeedMcpServer({
    publicConfig,
    defaultSiteUrl: requestedSiteUrl,
    probeEntry: ({ siteUrl, useConfiguredCredential }) => probeMoodleEntry({
      siteUrl,
      credentialProvider: useConfiguredCredential ? credentialProvider : null
    }),
    createRuntime: async () => createStandaloneRuntime(publicConfig, {
      credentialProvider,
      confirmationProvider: null
    })
  });
  await server.connect(transport);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startMoodleChangefeedStdio();
}
