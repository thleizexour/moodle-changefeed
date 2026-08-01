import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync
} from "node:fs";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stableResourceId(value) {
  return (
    typeof value === "string" &&
    /^moodle-resource:v1:[a-f0-9]{16}:[^:]{1,80}:.+$/.test(value)
  );
}

function responseSize(response) {
  const raw = response.headers?.get?.("content-length");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function mimeType(response) {
  return response.headers?.get?.("content-type")?.split(";", 1)[0]?.trim() || null;
}

function cacheError(reason) {
  const error = new Error(`Moodle cache ${reason}`);
  error.cacheReason = reason;
  return error;
}

async function removeIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export class MoodleResourceCache {
  constructor({
    store,
    client,
    dataDir,
    maxFileBytes,
    maxBatchBytes,
    now = () => Date.now()
  }) {
    if (!store || !client) throw new TypeError("store and client are required");
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
      throw new TypeError("dataDir must be an absolute private path");
    }
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
      throw new TypeError("maxFileBytes must be a positive integer");
    }
    if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1) {
      throw new TypeError("maxBatchBytes must be a positive integer");
    }
    this.store = store;
    this.client = client;
    this.privateRoot = dataDir;
    this.maxFileBytes = maxFileBytes;
    this.maxBatchBytes = maxBatchBytes;
    this.now = now;
    this.stagingDir = path.join(dataDir, "staging");
    this.cacheRoot = path.join(dataDir, "cache", "sha256");
    mkdirSync(this.stagingDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.cacheRoot, { recursive: true, mode: 0o700 });
  }

  resolveCachedPath(resource) {
    if (!resource?.contentSha256 || resource.cacheStatus !== "cached") return null;
    return path.join(
      this.cacheRoot,
      resource.contentSha256.slice(0, 2),
      resource.contentSha256
    );
  }

  #record(resourceId, { sha256: digest, bytes, cacheStatus }) {
    return this.store.recordCachedResource({
      resourceId,
      sha256: digest,
      bytes,
      cacheStatus,
      updatedAt: new Date(this.now()).toISOString()
    });
  }

  #quarantine(resourceId, reason, bytes = 0) {
    this.#record(resourceId, {
      sha256: null,
      bytes,
      cacheStatus: `quarantined:${reason}`
    });
    return { resourceId, status: "quarantined", reason };
  }

  async cache(input) {
    if (Object.hasOwn(input || {}, "outputPath")) {
      throw new TypeError("outputPath is not accepted");
    }
    const resourceIds = input?.resourceIds;
    if (
      !Array.isArray(resourceIds) ||
      resourceIds.length < 1 ||
      resourceIds.length > 100 ||
      resourceIds.some((id) => !stableResourceId(id))
    ) {
      throw new TypeError("resourceIds must contain 1–100 stable Moodle resource ids");
    }
    if (new Set(resourceIds).size !== resourceIds.length) {
      throw new TypeError("resourceIds must not contain duplicates");
    }

    const resources = new Map(
      this.store.getResources(resourceIds).map((resource) => [
        resource.resourceId,
        resource
      ])
    );
    const items = [];
    let totalBytes = 0;

    for (const resourceId of resourceIds) {
      const resource = resources.get(resourceId);
      if (!resource) {
        items.push({ resourceId, status: "not_found" });
        continue;
      }
      const existingPath = this.resolveCachedPath(resource);
      if (existingPath && existsSync(existingPath)) {
        items.push({
          resourceId,
          status: "already_cached",
          sha256: resource.contentSha256,
          bytes: resource.cachedBytes,
          warnings: []
        });
        continue;
      }

      const declaredBytes = resource.metadata?.size;
      if (Number.isSafeInteger(declaredBytes) && declaredBytes > this.maxFileBytes) {
        items.push(this.#quarantine(resourceId, "size_limit"));
        continue;
      }
      if (
        Number.isSafeInteger(declaredBytes) &&
        totalBytes + declaredBytes > this.maxBatchBytes
      ) {
        items.push({ resourceId, status: "batch_limit_reached" });
        break;
      }

      let response;
      try {
        response = await this.client.fetchResource(resource.locator);
      } catch {
        items.push(this.#quarantine(resourceId, "fetch_failed"));
        continue;
      }
      const headerBytes = responseSize(response);
      if (headerBytes !== null && headerBytes > this.maxFileBytes) {
        items.push(this.#quarantine(resourceId, "size_limit"));
        continue;
      }
      if (headerBytes !== null && totalBytes + headerBytes > this.maxBatchBytes) {
        items.push({ resourceId, status: "batch_limit_reached" });
        break;
      }

      const stagingPath = path.join(
        this.stagingDir,
        `${sha256(resourceId)}-${randomUUID()}.part`
      );
      const digest = createHash("sha256");
      let observedBytes = 0;
      const remainingBatchBytes = this.maxBatchBytes - totalBytes;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          observedBytes += chunk.length;
          if (observedBytes > remainingBatchBytes) {
            callback(cacheError("batch_limit"));
            return;
          }
          if (observedBytes > this.maxFileBytes) {
            callback(cacheError("size_limit"));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        }
      });
      meter.maxFileBytes = this.maxFileBytes;

      try {
        const source = response.body?.getReader
          ? Readable.fromWeb(response.body)
          : response.body
            ? Readable.from(response.body)
            : Readable.from([Buffer.from(await response.arrayBuffer())]);
        await pipeline(
          source,
          meter,
          createWriteStream(stagingPath, { flags: "wx", mode: 0o600 })
        );
      } catch (error) {
        await removeIfPresent(stagingPath);
        if (error.cacheReason === "batch_limit") {
          items.push({ resourceId, status: "batch_limit_reached" });
          break;
        }
        items.push(
          this.#quarantine(
            resourceId,
            error.cacheReason === "size_limit" ? "size_limit" : "stream_error",
            observedBytes
          )
        );
        continue;
      }

      const contentDigest = digest.digest("hex");
      const targetDirectory = path.join(this.cacheRoot, contentDigest.slice(0, 2));
      const targetPath = path.join(targetDirectory, contentDigest);
      mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
      if (existsSync(targetPath)) {
        await removeIfPresent(stagingPath);
      } else {
        await rename(stagingPath, targetPath);
      }
      chmodSync(targetPath, 0o600);

      const observedMimeType = mimeType(response);
      const warnings = [];
      if (
        resource.metadata?.mimeType &&
        observedMimeType &&
        resource.metadata.mimeType !== observedMimeType
      ) {
        warnings.push("mime_type_mismatch");
      }
      if (headerBytes !== null && headerBytes !== observedBytes) {
        warnings.push("content_length_mismatch");
      }
      this.#record(resourceId, {
        sha256: contentDigest,
        bytes: observedBytes,
        cacheStatus: "cached"
      });
      totalBytes += observedBytes;
      items.push({
        resourceId,
        status: "cached",
        sha256: contentDigest,
        bytes: observedBytes,
        mimeType: observedMimeType,
        warnings
      });
    }

    return { items, totalBytes };
  }
}
