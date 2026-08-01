#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createEnvironmentCredentialProvider,
  loadPublicConfig
} from "../config.mjs";
import { createStandaloneRuntime } from "../runtime.mjs";
import { registerMoodleChangefeedTools } from "./tools.mjs";

export function createMoodleChangefeedMcpServer({ createRuntime, publicConfig }) {
  const server = new McpServer(
    { name: "moodle-changefeed", version: "0.1.0-dev.0" },
    {
      instructions:
        "Call agent_bootstrap first. Moodle is read-only input; review writes only local state. Delivery requires a prepared plan and host-owned confirmation."
    }
  );
  registerMoodleChangefeedTools({ server, createRuntime, publicConfig });
  return server;
}
export async function startMoodleChangefeedStdio({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd()
} = {}) {
  const publicConfig = loadPublicConfig({ argv, env, cwd });
  const credentialProvider = createEnvironmentCredentialProvider(env);
  const server = createMoodleChangefeedMcpServer({
    publicConfig,
    createRuntime: async () => createStandaloneRuntime(publicConfig, {
      credentialProvider,
      confirmationProvider: null
    })
  });
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startMoodleChangefeedStdio();
}
