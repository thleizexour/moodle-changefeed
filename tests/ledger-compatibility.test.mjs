import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MoodlePipelineStore as LegacyStore } from "../../../src/moodle-pipeline-store.mjs";
import { backupLedger } from "../src/core/ledger-backup.mjs";
import { MoodlePipelineStore } from "../src/core/ledger.mjs";

const NOW = "2026-08-01T00:00:00.000Z";

async function digest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

test("opens a v1 private ledger and backs it up without resetting counts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "changefeed-compat-"));
  const dbPath = path.join(directory, "ledger.sqlite");
  const backupPath = path.join(directory, "ledger.backup.sqlite");
  try {
    const legacy = new LegacyStore({ dbPath, now: () => Date.parse(NOW) });
    const object = {
      objectId: "moodle-object:v1:0123456789abcdef:42:assignment:7",
      type: "assignment",
      course: { id: "42", code: null, name: "Example", term: null },
      metadataHash: "a".repeat(64)
    };
    const scanId = legacy.beginScan({ scope: "all", startedAt: NOW });
    legacy.commitScan({
      scanId,
      complete: true,
      health: { status: "healthy" },
      objects: [object],
      resources: [],
      changes: [],
      completedAt: NOW
    });
    legacy.close();

    const before = await digest(dbPath);
    const store = new MoodlePipelineStore({ dbPath, now: () => Date.parse(NOW) });
    assert.equal(store.getStatus().objectCount, 1);
    assert.equal(store.getStatus().resourceCount, 0);
    assert.equal(store.getStatus().counts.total, 0);
    store.close();

    const report = await backupLedger({
      sourcePath: dbPath,
      destinationPath: backupPath
    });
    assert.equal(report.sha256, await digest(backupPath));
    assert.equal(report.bytes, (await stat(backupPath)).size);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    assert.equal(before.length, 64);
    await assert.rejects(
      backupLedger({ sourcePath: dbPath, destinationPath: backupPath }),
      /exist/i
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ledger backup refuses destinations inside a Git worktree", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "changefeed-compat-"));
  const dbPath = path.join(directory, "ledger.sqlite");
  const store = new MoodlePipelineStore({ dbPath });
  store.close();
  try {
    await assert.rejects(
      backupLedger({
        sourcePath: dbPath,
        destinationPath: path.resolve("packages/moodle-changefeed/ledger.backup.sqlite")
      }),
      /Git worktree/i
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
