import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryConfirmationProvider,
  MoodleDeliveryCoordinator
} from "../src/core/delivery-coordinator.mjs";

const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const ITEM = {
  id: "moodle-change:v1:0123456789abcdef0123456789abcdef",
  version: 2,
  reviewStatus: "approved",
  afterHash: "a".repeat(64),
  objectId: "moodle-object:v1:0123456789abcdef:42:assignment:1",
  type: "assignment",
  title: "Example assignment",
  course: { id: "42", code: "EXAMPLE42", name: "Example course", term: "2026-S1" },
  resourceIds: []
};

class Store {
  constructor() {
    this.item = structuredClone(ITEM);
    this.deliveries = new Map();
  }
  getReviewItem(id) { return id === this.item.id ? structuredClone(this.item) : null; }
  getResources() { return []; }
  getDelivery(key) { return structuredClone(this.deliveries.get(key) || null); }
  recordDelivery(record) {
    this.deliveries.set(record.deliveryKey, structuredClone(record));
    return structuredClone(record);
  }
}

function adapter() {
  return {
    id: "local_archive",
    executeCalls: 0,
    fingerprint() { return "local-archive:v1:target-a"; },
    plan({ items }) {
      return items.map((item) => ({
        id: `moodle-delivery-op:v1:${"b".repeat(64)}`,
        itemId: item.id,
        resourceId: null,
        expectedReviewVersion: item.version,
        expectedAfterHash: item.afterHash,
        contentHash: "c".repeat(64),
        logicalArchiveSegments: ["Moodle", "Example"],
        targetType: "task"
      }));
    },
    async execute() {
      this.executeCalls += 1;
      return { status: "delivered", externalRef: "opaque-ref" };
    }
  };
}

test("standalone coordinator cannot execute without a host confirmation provider", async () => {
  const target = adapter();
  const coordinator = new MoodleDeliveryCoordinator({
    store: new Store(),
    adapters: [target],
    clock: () => NOW,
    writeEnabled: true
  });
  const plan = await coordinator.prepare({
    reviewItemIds: [ITEM.id],
    targets: ["local_archive"]
  });

  await assert.rejects(
    coordinator.deliver({ planHash: plan.planHash, confirmationToken: "x" }),
    (error) => error.code === "confirmation_provider_required"
  );
  assert.equal(target.executeCalls, 0);
});

test("confirmation is single-use and bound to exact plan evidence", async () => {
  const target = adapter();
  const store = new Store();
  const confirmationProvider = new MemoryConfirmationProvider({ clock: () => NOW });
  const coordinator = new MoodleDeliveryCoordinator({
    store,
    adapters: [target],
    confirmationProvider,
    clock: () => NOW,
    writeEnabled: true
  });
  const plan = await coordinator.prepare({
    reviewItemIds: [ITEM.id],
    targets: ["local_archive"]
  });
  const confirmationToken = confirmationProvider.issue({
    binding: coordinator.getConfirmationBinding(plan.planHash),
    expiresAt: NOW + 60_000
  });

  const delivered = await coordinator.deliver({
    planHash: plan.planHash,
    confirmationToken
  });
  assert.equal(delivered.succeeded, 1);
  assert.equal(target.executeCalls, 1);
  await assert.rejects(
    coordinator.deliver({ planHash: plan.planHash, confirmationToken }),
    (error) => error.code === "confirmation_invalid"
  );
  assert.equal(target.executeCalls, 1);
});

test("changed review version fails before adapter execution", async () => {
  const target = adapter();
  const store = new Store();
  const confirmationProvider = new MemoryConfirmationProvider({ clock: () => NOW });
  const coordinator = new MoodleDeliveryCoordinator({
    store,
    adapters: [target],
    confirmationProvider,
    clock: () => NOW,
    writeEnabled: true
  });
  const plan = await coordinator.prepare({ reviewItemIds: [ITEM.id] });
  const confirmationToken = confirmationProvider.issue({
    binding: coordinator.getConfirmationBinding(plan.planHash),
    expiresAt: NOW + 60_000
  });
  store.item.version += 1;

  await assert.rejects(
    coordinator.deliver({ planHash: plan.planHash, confirmationToken }),
    (error) => error.code === "delivery_plan_stale"
  );
  assert.equal(target.executeCalls, 0);
});

test("public delivery plan remains a closed-schema object", async () => {
  const coordinator = new MoodleDeliveryCoordinator({
    store: new Store(),
    adapters: [adapter()],
    clock: () => NOW
  });
  const plan = await coordinator.prepare({ reviewItemIds: [ITEM.id] });

  assert.deepEqual(Object.keys(plan).sort(), [
    "expiresAt",
    "operations",
    "planHash",
    "schemaVersion",
    "summary"
  ]);
  assert.match(coordinator.getConfirmationBinding(plan.planHash), /^[a-f0-9]{64}$/);
});
