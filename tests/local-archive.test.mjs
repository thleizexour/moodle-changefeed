import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalArchiveAdapter } from "../src/adapters/local-archive/index.mjs";

const BYTES = Buffer.from("verified Moodle bytes");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "changefeed-archive-"));
  const cachePath = path.join(directory, "cache.bin");
  const rootDir = path.join(directory, "archive");
  await writeFile(cachePath, BYTES, { mode: 0o600 });
  const resource = {
    resourceId: "moodle-resource:v1:0123456789abcdef:42:99",
    contentSha256: DIGEST,
    cachedBytes: BYTES.length,
    cacheStatus: "cached"
  };
  const adapter = new LocalArchiveAdapter({
    rootDir,
    cache: { resolveCachedPath(value) { return value.resourceId === resource.resourceId ? cachePath : null; } }
  });
  const operation = {
    id: `moodle-delivery-op:v1:${"b".repeat(64)}`,
    itemId: "moodle-change:v1:0123456789abcdef0123456789abcdef",
    resourceId: resource.resourceId,
    contentHash: DIGEST,
    logicalArchiveSegments: ["Moodle", "2026-S1", "Example course"],
    targetType: "archive_file",
    fileName: "brief.pdf",
    bytes: BYTES.length,
    resource
  };
  try {
    return await run({ adapter, operation, rootDir });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("local archive writes verified bytes and returns only an opaque receipt", async () => {
  await fixture(async ({ adapter, operation, rootDir }) => {
    const receipt = await adapter.execute(operation);
    assert.equal(receipt.status, "delivered");
    assert.equal(receipt.contentHash, DIGEST);
    assert.match(receipt.externalRef, /^local-archive-ref:v1:[a-f0-9]{24}$/);
    assert.equal(JSON.stringify(receipt).includes(rootDir), false);
    assert.deepEqual(
      await readFile(path.join(rootDir, ...operation.logicalArchiveSegments, operation.fileName)),
      BYTES
    );
  });
});

test("local archive never overwrites an unknown same-name file", async () => {
  await fixture(async ({ adapter, operation, rootDir }) => {
    const parent = path.join(rootDir, ...operation.logicalArchiveSegments);
    await mkdir(parent, { recursive: true });
    await writeFile(path.join(parent, operation.fileName), "ownerless");
    await assert.rejects(
      adapter.execute(operation),
      (error) => error.code === "archive_target_conflict"
    );
    assert.equal(
      await readFile(path.join(parent, operation.fileName), "utf8"),
      "ownerless"
    );
  });
});
