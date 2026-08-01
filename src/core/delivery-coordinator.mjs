import {
  canonicalJson,
  sha256Hex
} from "./contracts.mjs";
import { MemoryConfirmationProvider } from "./confirmation.mjs";
import { ChangefeedError } from "./errors.mjs";

export { MemoryConfirmationProvider };

const PLAN_TTL_MS = 10 * 60 * 1000;

export function assertDeliveryAdapter(adapter) {
  for (const name of ["fingerprint", "plan", "execute"]) {
    if (typeof adapter?.[name] !== "function") {
      throw new TypeError(`delivery adapter missing ${name}()`);
    }
  }
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(adapter.id || "")) {
    throw new TypeError("invalid delivery adapter id");
  }
  return adapter;
}

function publicOperation(operation) {
  if (!["task", "archive_file"].includes(operation.targetType)) {
    throw new TypeError("delivery operation has an invalid targetType");
  }
  if (!/^[a-f0-9]{64}$/.test(operation.contentHash || "")) {
    throw new TypeError("delivery operation requires a content hash");
  }
  return {
    id: operation.id,
    itemId: operation.itemId,
    resourceId: operation.resourceId ?? null,
    expectedReviewVersion: operation.expectedReviewVersion,
    contentHash: operation.contentHash,
    logicalArchiveSegments: [...operation.logicalArchiveSegments],
    targetType: operation.targetType
  };
}

function planKey(planHash) {
  return `moodle-plan:${planHash}`;
}

function deliveryKey(adapterId, operationId) {
  return `moodle-delivery:${adapterId}:${operationId}`;
}

export class MoodleDeliveryCoordinator {
  constructor({
    store,
    adapters,
    confirmationProvider = null,
    clock = () => Date.now(),
    writeEnabled = false
  }) {
    if (!store || !Array.isArray(adapters) || adapters.length === 0) {
      throw new TypeError("store and at least one delivery adapter are required");
    }
    this.store = store;
    this.adapters = new Map();
    for (const adapter of adapters.map(assertDeliveryAdapter)) {
      if (this.adapters.has(adapter.id)) throw new TypeError("duplicate delivery adapter id");
      this.adapters.set(adapter.id, adapter);
    }
    this.confirmationProvider = confirmationProvider;
    this.clock = clock;
    this.writeEnabled = Boolean(writeEnabled);
  }

  #items(reviewItemIds) {
    if (
      !Array.isArray(reviewItemIds) ||
      reviewItemIds.length < 1 ||
      reviewItemIds.length > 100 ||
      new Set(reviewItemIds).size !== reviewItemIds.length
    ) {
      throw new TypeError("reviewItemIds must contain 1-100 unique ids");
    }
    return [...reviewItemIds].sort().map((id) => {
      const item = this.store.getReviewItem(id);
      if (!item) throw new ChangefeedError("review_not_found", "Review item not found");
      if (item.reviewStatus !== "approved") {
        throw new ChangefeedError("review_not_approved", "Review item is not approved");
      }
      return item;
    });
  }

  #selectedAdapters(targets) {
    const ids = targets === undefined ? [...this.adapters.keys()] : targets;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !this.adapters.has(id))
    ) {
      throw new TypeError("targets must name unique configured delivery adapters");
    }
    return [...ids].sort().map((id) => this.adapters.get(id));
  }

  async prepare({ reviewItemIds, targets } = {}) {
    const items = this.#items(reviewItemIds);
    const adapters = this.#selectedAdapters(targets);
    const resourceIds = [...new Set(items.flatMap((item) => item.resourceIds || []))].sort();
    const resources = this.store.getResources(resourceIds);
    const internalOperations = [];
    const adapterFingerprints = {};
    for (const adapter of adapters) {
      const fingerprint = await adapter.fingerprint();
      if (typeof fingerprint !== "string" || fingerprint.length < 8) {
        throw new TypeError("delivery adapter returned an invalid fingerprint");
      }
      adapterFingerprints[adapter.id] = fingerprint;
      const planned = await adapter.plan({ items, resources });
      if (!Array.isArray(planned)) throw new TypeError("delivery adapter plan() must return an array");
      for (const operation of planned) {
        internalOperations.push({ ...operation, adapterId: adapter.id, adapterFingerprint: fingerprint });
      }
    }
    if (internalOperations.length < 1 || internalOperations.length > 200) {
      throw new ChangefeedError("delivery_plan_empty", "Delivery plan must contain 1-200 operations");
    }
    internalOperations.sort(
      (left, right) =>
        left.adapterId.localeCompare(right.adapterId) || left.id.localeCompare(right.id)
    );
    const operations = internalOperations.map(publicOperation);
    const reviewBindings = items.map((item) => ({
      itemId: item.id,
      expectedReviewVersion: item.version,
      expectedAfterHash: item.afterHash ?? null
    }));
    const expiresAtMs = this.clock() + PLAN_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const evidence = {
      schemaVersion: 1,
      expiresAt,
      adapterFingerprints,
      reviewBindings,
      operations
    };
    const planHash = sha256Hex(canonicalJson(evidence));
    const confirmationBinding = sha256Hex(
      canonicalJson({ planHash, ...evidence })
    );
    const publicPlan = {
      schemaVersion: 1,
      planHash,
      expiresAt,
      summary: {
        taskCount: operations.filter((item) => item.targetType === "task").length,
        fileCount: operations.filter((item) => item.targetType === "archive_file").length,
        totalBytes: internalOperations.reduce(
          (total, item) => total + (Number.isSafeInteger(item.bytes) ? item.bytes : 0),
          0
        )
      },
      operations
    };
    this.store.recordDelivery({
      deliveryKey: planKey(planHash),
      changeId: items[0].id,
      targetType: "delivery_plan",
      contentHash: planHash,
      status: "prepared",
      receipt: { evidence, publicPlan, confirmationBinding, internalOperations },
      updatedAt: new Date(this.clock()).toISOString()
    });
    return publicPlan;
  }

  getConfirmationBinding(planHash) {
    return this.#load(planHash).confirmationBinding;
  }

  #load(planHash) {
    if (!/^[a-f0-9]{64}$/.test(planHash || "")) {
      throw new TypeError("invalid planHash");
    }
    const record = this.store.getDelivery(planKey(planHash));
    const stored = record?.receipt;
    if (!stored?.evidence || !stored?.publicPlan || !stored?.internalOperations) {
      throw new ChangefeedError("delivery_plan_not_found", "Delivery plan not found");
    }
    if (sha256Hex(canonicalJson(stored.evidence)) !== planHash) {
      throw new ChangefeedError("delivery_plan_invalid", "Delivery plan integrity check failed");
    }
    return stored;
  }

  async #assertCurrent(stored) {
    if (Date.parse(stored.publicPlan.expiresAt) < this.clock()) {
      throw new ChangefeedError("delivery_plan_expired", "Delivery plan expired");
    }
    for (const [adapterId, expected] of Object.entries(stored.evidence.adapterFingerprints)) {
      const adapter = this.adapters.get(adapterId);
      if (!adapter || (await adapter.fingerprint()) !== expected) {
        throw new ChangefeedError("delivery_plan_stale", "Delivery adapter target changed");
      }
    }
    for (const binding of stored.evidence.reviewBindings) {
      const item = this.store.getReviewItem(binding.itemId);
      if (
        !item ||
        item.reviewStatus !== "approved" ||
        item.version !== binding.expectedReviewVersion ||
        (item.afterHash ?? null) !== binding.expectedAfterHash
      ) {
        throw new ChangefeedError("delivery_plan_stale", "Review evidence changed");
      }
    }
    for (const operation of stored.internalOperations) {
      if (!operation.resourceId) continue;
      const resource = this.store.getResources([operation.resourceId])[0];
      if (
        !resource ||
        resource.cacheStatus !== "cached" ||
        resource.contentSha256 !== operation.contentHash
      ) {
        throw new ChangefeedError("delivery_plan_stale", "Cached resource changed");
      }
    }
  }

  async deliver({ planHash, confirmationToken }) {
    if (!this.writeEnabled) {
      throw new ChangefeedError("delivery_write_disabled", "Delivery writes are disabled");
    }
    const stored = this.#load(planHash);
    await this.#assertCurrent(stored);
    if (!this.confirmationProvider?.consume) {
      throw new ChangefeedError(
        "confirmation_provider_required",
        "A host confirmation provider is required"
      );
    }
    await this.confirmationProvider.consume({
      token: confirmationToken,
      binding: stored.confirmationBinding
    });

    let succeeded = 0;
    let replayed = 0;
    const receipts = [];
    for (const operation of stored.internalOperations) {
      const key = deliveryKey(operation.adapterId, operation.id);
      const existing = this.store.getDelivery(key);
      if (existing?.status === "delivered" && existing.contentHash === operation.contentHash) {
        replayed += 1;
        receipts.push(existing.receipt);
        continue;
      }
      const adapter = this.adapters.get(operation.adapterId);
      const result = await adapter.execute(operation);
      const receipt = {
        status: result?.status || "delivered",
        targetType: operation.targetType,
        contentHash: operation.contentHash,
        externalRef: result?.externalRef || `delivery-ref:v1:${sha256Hex(key).slice(0, 24)}`
      };
      this.store.recordDelivery({
        deliveryKey: key,
        changeId: operation.itemId,
        targetType: operation.targetType,
        contentHash: operation.contentHash,
        status: receipt.status,
        receipt,
        updatedAt: new Date(this.clock()).toISOString()
      });
      succeeded += 1;
      receipts.push(receipt);
    }
    return { schemaVersion: 1, planHash, succeeded, replayed, receipts };
  }
}
