import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MOODLE_CHANGE_KINDS,
  MOODLE_FEED_SCHEMA_VERSION,
  MOODLE_REVIEW_STATUSES,
  canonicalJson,
  canonicalSiteKey,
  decodeMoodleCursor,
  encodeMoodleCursor,
  makeMoodleChangeId,
  makeMoodleObjectId,
  makeMoodleResourceId,
  moodleFeedQuerySchema,
  moodleReviewActionSchema,
  projectMoodleFeed,
  sha256Hex
} from "../src/core/contracts.mjs";

const vectorUrl = new URL(
  "../fixtures/conformance/v1/ids.json",
  import.meta.url
);

const schemaUrls = [
  new URL("../schemas/change-feed-v1.schema.json", import.meta.url),
  new URL("../schemas/review-action-v1.schema.json", import.meta.url),
  new URL("../schemas/delivery-plan-v1.schema.json", import.meta.url)
];

function assertClosedObjectSchemas(value, location = "schema") {
  if (!value || typeof value !== "object") return;
  if (value.type === "object") {
    assert.equal(
      value.additionalProperties,
      false,
      `${location} must reject unversioned properties`
    );
  }
  for (const [key, child] of Object.entries(value)) {
    assertClosedObjectSchemas(child, `${location}.${key}`);
  }
}

test("v1 identifiers and cursor match published vectors", async () => {
  const vector = JSON.parse(await readFile(vectorUrl, "utf8"));
  const objectId = makeMoodleObjectId(vector.object.input);

  assert.equal(objectId, vector.object.expected);
  assert.equal(makeMoodleResourceId(vector.resource.input), vector.resource.expected);
  assert.equal(
    makeMoodleChangeId({ ...vector.change.input, objectId }),
    vector.change.expected
  );
  assert.equal(encodeMoodleCursor(vector.cursor.input), vector.cursor.expected);
  assert.deepEqual(decodeMoodleCursor(vector.cursor.expected), {
    schemaVersion: 1,
    sequence: 17
  });
});

test("canonical JSON and SHA-256 are stable public primitives", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, x: [3, 2, 1] } }),
    '{"a":{"x":[3,2,1],"y":true},"z":1}'
  );
  assert.equal(
    sha256Hex("moodle-changefeed"),
    "c6cbb62bd11e360bca93493f1e226710961c146a0d77316fef268b668607ed10"
  );
});

test("site keys normalize HTTPS roots and preserve Moodle base paths", () => {
  assert.equal(
    canonicalSiteKey("https://MOODLE.EXAMPLE.EDU:443/"),
    "https://moodle.example.edu"
  );
  assert.equal(
    canonicalSiteKey("https://Moodle.Example.Edu:443/learn/moodle/"),
    "https://moodle.example.edu/learn/moodle"
  );

  for (const invalid of [
    "http://moodle.example.edu",
    "https://user:password@moodle.example.edu",
    "https://moodle.example.edu/?token=secret",
    "https://moodle.example.edu/#fragment"
  ]) {
    assert.throws(() => canonicalSiteKey(invalid), /site|https|query|fragment/i);
  }
});

test("cursor decoding rejects malformed and non-canonical payloads", () => {
  const invalid = [
    "not-base64-json",
    Buffer.from('{"sequence":17,"schemaVersion":1}').toString("base64url"),
    `${encodeMoodleCursor(17)}=`,
    Buffer.from('{"schemaVersion":1,"sequence":17,"extra":true}').toString(
      "base64url"
    )
  ];

  for (const cursor of invalid) {
    assert.throws(() => decodeMoodleCursor(cursor), /cursor/i);
  }
});

test("v1 validators and feed projection retain the compact closed contract", () => {
  assert.equal(MOODLE_FEED_SCHEMA_VERSION, 1);
  assert.deepEqual(MOODLE_CHANGE_KINDS, [
    "added",
    "metadata_changed",
    "content_changed",
    "possibly_missing",
    "access_lost",
    "unchanged"
  ]);
  assert.deepEqual(MOODLE_REVIEW_STATUSES, [
    "pending",
    "approved",
    "ignored",
    "deferred",
    "ready_for_delivery",
    "delivered",
    "failed"
  ]);
  assert.deepEqual(moodleFeedQuerySchema.parse({ limit: 20 }), { limit: 20 });
  assert.equal(
    moodleReviewActionSchema.safeParse({
      schemaVersion: 1,
      actions: [
        { id: "moodle-change:v1:0123456789abcdef", expectedVersion: 1, decision: "approve" }
      ]
    }).success,
    true
  );

  const feed = projectMoodleFeed({
    generatedAt: "2026-08-01T00:00:00.000Z",
    cursor: null,
    health: { status: "not_scanned", scanComplete: false },
    counts: {
      total: 0,
      pending: 0,
      approved: 0,
      ignored: 0,
      deferred: 0,
      readyForDelivery: 0,
      delivered: 0,
      failed: 0
    },
    privatePath: "/private/ledger.sqlite",
    items: []
  });
  assert.deepEqual(feed, {
    schemaVersion: 1,
    generatedAt: "2026-08-01T00:00:00.000Z",
    cursor: null,
    health: {
      status: "not_scanned",
      lastCompleteScanAt: null,
      scanComplete: false
    },
    counts: {
      total: 0,
      pending: 0,
      approved: 0,
      ignored: 0,
      deferred: 0,
      readyForDelivery: 0,
      delivered: 0,
      failed: 0
    },
    items: []
  });
});

test("published v1 JSON Schemas are generic and closed", async () => {
  for (const schemaUrl of schemaUrls) {
    const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assertClosedObjectSchemas(schema);
    assert.doesNotMatch(JSON.stringify(schema), /personal-study-assistant|feishu|hku/i);
  }

  const deliverySchema = JSON.parse(await readFile(schemaUrls[2], "utf8"));
  assert.deepEqual(
    deliverySchema.properties.operations.items.properties.targetType.enum,
    ["task", "archive_file"]
  );
});
