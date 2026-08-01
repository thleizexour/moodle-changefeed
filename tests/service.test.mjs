import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MoodlePipelineService,
  ChangefeedError
} from "../src/core/service.mjs";
import { diffMoodleObjects } from "../src/core/diff.mjs";
import { MoodlePipelineStore } from "../src/core/ledger.mjs";
import { normalizeMoodleSnapshot } from "../src/core/normalize.mjs";

const NOW = Date.parse("2026-08-01T00:00:00.000Z");

function snapshot({ dueAt, extraAssignment = false, complete = true }) {
  return {
    siteKey: "https://moodle.example.edu",
    capturedAt: new Date(NOW).toISOString(),
    courses: [{ id: 42, shortname: "EXAMPLE42", fullname: "Example course" }],
    coursePayloads: [
      {
        courseId: 42,
        contents: [],
        announcements: [],
        assignments: [
          { id: 1, name: "Assignment 1", dueAt, intro: "private body" },
          ...(extraAssignment
            ? [{ id: 2, name: "Assignment 2", dueAt, intro: "another private body" }]
            : [])
        ]
      }
    ],
    icsEvents: [],
    complete,
    health: {
      status: complete ? "healthy" : "degraded",
      completeness: { resources: complete, assignments: true, announcements: true }
    }
  };
}

async function withService(snapshots, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "changefeed-service-"));
  const store = new MoodlePipelineStore({
    dbPath: path.join(directory, "ledger.sqlite"),
    now: () => NOW
  });
  let index = 0;
  const sourceAdapter = {
    async collect() {
      return snapshots[Math.min(index++, snapshots.length - 1)];
    }
  };
  const service = new MoodlePipelineService({
    store,
    sourceAdapter,
    normalizer: normalizeMoodleSnapshot,
    diffEngine: diffMoodleObjects,
    resourceCache: { async cache() { return { items: [], totalBytes: 0 }; } },
    scanLockPath: path.join(directory, "scan.lock"),
    clock: () => NOW
  });
  try {
    return await run({ service, store });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("first complete scan creates a baseline and zero review items", async () => {
  await withService(
    [snapshot({ dueAt: "2026-08-08T00:00:00.000Z" })],
    async ({ service }) => {
      const result = await service.scan();
      assert.equal(result.baselineCreated, true);
      assert.equal(result.createdReviewItems, 0);
      assert.equal((await service.getFeed({ limit: 20 })).items.length, 0);
    }
  );
});

test("a partial adapter result preserves the complete baseline", async () => {
  await withService(
    [
      snapshot({ dueAt: "2026-08-08T00:00:00.000Z" }),
      { ...snapshot({ dueAt: "2026-08-08T00:00:00.000Z", complete: false }), coursePayloads: [] }
    ],
    async ({ service, store }) => {
      await service.scan();
      const before = store.getCurrentObjects();
      const result = await service.scan();
      assert.equal(result.health.scanComplete, false);
      assert.equal(result.changeCounts.possibly_missing, 0);
      assert.equal(Object.hasOwn(result, "changes"), false);
      assert.doesNotMatch(JSON.stringify(result), /private body|Example course/);
      assert.deepEqual(store.getCurrentObjects(), before);
    }
  );
});

test("feed pagination and optimistic conflicts have stable public behavior", async () => {
  await withService(
    [
      snapshot({ dueAt: "2026-08-08T00:00:00.000Z" }),
      snapshot({ dueAt: "2026-08-02T00:00:00.000Z", extraAssignment: true })
    ],
    async ({ service }) => {
      await service.scan();
      await service.scan();
      const first = await service.getFeed({ limit: 1 });
      assert.equal(first.items.length, 1);
      assert.equal(typeof first.cursor, "string");
      const second = await service.getFeed({ cursor: first.cursor, limit: 1 });
      assert.equal(second.items.length, 1);
      assert.notEqual(first.items[0].id, second.items[0].id);

      await service.setReviewDecision({
        actions: [
          { id: first.items[0].id, expectedVersion: 1, decision: "defer" }
        ]
      });
      await assert.rejects(
        service.setReviewDecision({
          actions: [
            { id: first.items[0].id, expectedVersion: 1, decision: "ignore" }
          ]
        }),
        (error) =>
          error instanceof ChangefeedError &&
          error.code === "review_version_conflict" &&
          JSON.stringify(error.details) === "{}"
      );
    }
  );
});
