import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MoodleResourceCache } from "../src/cache/resource-cache.mjs";

const RESOURCE_ID = "moodle-resource:v1:0123456789abcdef:42:99";

class Store {
  constructor(mimeType) {
    this.resource = {
      resourceId: RESOURCE_ID,
      objectId: "moodle-object:v1:0123456789abcdef:42:resource:99",
      metadata: { fileName: "payload.bin", size: null, mimeType },
      locator: {
        pathname: "/webservice/pluginfile.php/42/mod_resource/content/1/payload.bin",
        forcedownload: false
      },
      contentSha256: null,
      cacheStatus: "not_cached",
      cachedBytes: null,
      updatedAt: "2026-08-01T00:00:00.000Z"
    };
  }
  getResources(ids) { return ids.includes(RESOURCE_ID) ? [structuredClone(this.resource)] : []; }
  recordCachedResource(record) {
    Object.assign(this.resource, {
      contentSha256: record.sha256,
      cachedBytes: record.bytes,
      cacheStatus: record.cacheStatus,
      updatedAt: record.updatedAt
    });
    return structuredClone(this.resource);
  }
}

test("cache accepts content by bytes rather than filename extension", async () => {
  for (const mimeType of [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/png",
    "text/plain",
    "application/zip",
    "application/octet-stream"
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "changefeed-cache-"));
    const bytes = new TextEncoder().encode(`bytes:${mimeType}`);
    const cache = new MoodleResourceCache({
      store: new Store(mimeType),
      client: {
        async fetchResource() {
          return new Response(bytes, {
            status: 200,
            headers: { "content-type": mimeType, "content-length": String(bytes.length) }
          });
        }
      },
      dataDir: root,
      maxFileBytes: 1024,
      maxBatchBytes: 4096
    });
    try {
      const result = await cache.cache({ resourceIds: [RESOURCE_ID] });
      assert.equal(result.items[0].status, "cached");
      assert.match(result.items[0].sha256, /^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a failed resource stream leaves no completed cache file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "changefeed-cache-"));
  const cache = new MoodleResourceCache({
    store: new Store("application/pdf"),
    client: { async fetchResource() { throw new Error("network failed"); } },
    dataDir: root,
    maxFileBytes: 1024,
    maxBatchBytes: 4096
  });
  try {
    const result = await cache.cache({ resourceIds: [RESOURCE_ID] });
    assert.equal(result.items[0].status, "quarantined");
    assert.deepEqual(await readdir(path.join(root, "staging")), []);
    assert.deepEqual(await readdir(path.join(root, "cache", "sha256")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
