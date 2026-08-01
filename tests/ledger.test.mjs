import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MoodlePipelineStore } from "../src/core/ledger.mjs";

const NOW = "2026-08-01T00:00:00.000Z";
const OBJECT = {
  objectId: "moodle-object:v1:0123456789abcdef:42:assignment:7",
  type: "assignment",
  course: { id: "42", code: null, name: "Example", term: null },
  sourceId: "7",
  title: "Assignment",
  dueAt: null,
  sourceUpdatedAt: NOW,
  metadataHash: "a".repeat(64),
  contentHash: "b".repeat(64),
  sourceLink: null,
  prioritySignals: [],
  resourceIds: []
};
const CHANGE = {
  changeId: "moodle-change:v1:0123456789abcdef0123456789abcdef",
  objectId: OBJECT.objectId,
  changeKind: "added",
  beforeHash: null,
  afterHash: "c".repeat(64),
  payload: OBJECT,
  createdAt: NOW
};

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "changefeed-ledger-"));
  const store = new MoodlePipelineStore({
    dbPath: path.join(directory, "ledger.sqlite"),
    now: () => Date.parse(NOW)
  });
  try {
    return await run(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function addPendingReview(store) {
  const scanId = store.beginScan({ scope: "all", startedAt: NOW });
  store.commitScan({
    scanId,
    complete: true,
    health: { status: "healthy" },
    objects: [OBJECT],
    resources: [],
    changes: [CHANGE],
    completedAt: NOW
  });
}

test("ledger preserves optimistic review transitions", async () => {
  await withStore((store) => {
    addPendingReview(store);
    const approved = store.setReviewDecision({
      id: CHANGE.changeId,
      expectedVersion: 1,
      decision: "approve",
      updatedAt: NOW
    });
    assert.equal(approved.reviewStatus, "approved");
    assert.equal(approved.version, 2);
    assert.throws(
      () =>
        store.setReviewDecision({
          id: CHANGE.changeId,
          expectedVersion: 1,
          decision: "ignore",
          updatedAt: NOW
        }),
      /version|版本/i
    );
  });
});

test("confirmation tokens are target-bound and single-use", async () => {
  await withStore((store) => {
    const expiresAt = Date.parse(NOW) + 60_000;
    const prepared = store.prepareConfirmation({
      action: "delivery.execute",
      targetHash: "a".repeat(64),
      expiresAt
    });
    assert.deepEqual(
      store.consumeConfirmation({
        token: prepared.confirmationToken,
        action: "delivery.execute",
        targetHash: "a".repeat(64),
        now: Date.parse(NOW)
      }),
      {
        action: "delivery.execute",
        targetHash: "a".repeat(64),
        consumedAt: Date.parse(NOW)
      }
    );
    assert.throws(
      () =>
        store.consumeConfirmation({
          token: prepared.confirmationToken,
          action: "delivery.execute",
          targetHash: "a".repeat(64),
          now: Date.parse(NOW)
        }),
      /invalid|used|无效|使用/i
    );
  });
});
