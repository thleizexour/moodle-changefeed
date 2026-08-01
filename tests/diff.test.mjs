import assert from "node:assert/strict";
import test from "node:test";

import { diffMoodleObjects } from "../src/core/diff.mjs";

const CREATED_AT = "2026-08-01T00:00:00.000Z";

function object(overrides = {}) {
  return {
    objectId: "moodle-object:v1:site:42:assignment:1",
    type: "assignment",
    course: { id: "42", code: null, name: "Example", term: null },
    sourceId: "1",
    title: "Assignment",
    dueAt: "2026-08-08T00:00:00.000Z",
    sourceUpdatedAt: CREATED_AT,
    metadataHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    sourceLink: null,
    prioritySignals: [],
    resourceIds: [],
    ...overrides
  };
}

test("an incomplete scan never emits possibly_missing", () => {
  const changes = diffMoodleObjects([object()], [], {
    complete: false,
    createdAt: CREATED_AT
  });
  assert.deepEqual(changes, []);
});

test("baseline scans emit nothing and complete scans emit stable missing changes", () => {
  assert.deepEqual(
    diffMoodleObjects([], [object()], {
      baseline: true,
      complete: true,
      createdAt: CREATED_AT
    }),
    []
  );

  const first = diffMoodleObjects([object()], [], {
    complete: true,
    createdAt: CREATED_AT
  });
  const replay = diffMoodleObjects([object()], [], {
    complete: true,
    createdAt: CREATED_AT
  });
  assert.equal(first[0].changeKind, "possibly_missing");
  assert.equal(first[0].changeId, replay[0].changeId);
});

test("content and metadata changes receive deterministic priority signals", () => {
  const before = object({
    dueAt: "2026-08-08T00:00:00.000Z",
    resourceIds: ["resource-a"]
  });
  const content = object({
    dueAt: "2026-08-02T00:00:00.000Z",
    metadataHash: "c".repeat(64),
    contentHash: "d".repeat(64),
    prioritySignals: ["due_within_7d"],
    resourceIds: ["resource-b"]
  });

  const [change] = diffMoodleObjects([before], [content], {
    complete: true,
    createdAt: CREATED_AT
  });
  assert.equal(change.changeKind, "content_changed");
  assert.deepEqual(change.payload.prioritySignals, [
    "due_within_7d",
    "due_changed_earlier",
    "required_resource_changed",
    "content_verification_required"
  ]);
});

test("invalid diff input fails before producing changes", () => {
  assert.throws(() => diffMoodleObjects({}, []), /arrays/i);
  assert.throws(() => diffMoodleObjects([], {}), /arrays/i);
});
