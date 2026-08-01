#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { auditPublicTree } from "./public-audit.mjs";

const execFileAsync = promisify(execFile);

export async function verifyRelease({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  denylistPath = process.env.MOODLE_CHANGEFEED_PUBLIC_DENYLIST_PATH,
  requireDenylist = false,
} = {}) {
  const test = await execFileAsync("node", ["--test"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const audit = await auditPublicTree({ root, denylistPath, requireDenylist });
  return {
    ok: audit.ok,
    testsPassed: true,
    audit,
  };
}

async function main() {
  const report = await verifyRelease({ requireDenylist: process.argv.includes("--require-denylist") });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    testsPassed: report.testsPassed,
    findings: report.audit.findings,
    fileCount: report.audit.fileCount,
    packFileCount: report.audit.packFiles.length,
    licenseCount: report.audit.licenseInventory.length,
  })}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
