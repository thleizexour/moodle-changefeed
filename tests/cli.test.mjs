import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCli } from "../src/cli/parse.mjs";
import { runCli } from "../src/cli/main.mjs";
import { loadPublicConfig } from "../src/config.mjs";
import { restrictSnapshotToDomains } from "../src/runtime.mjs";

test("CLI rejects Moodle secrets in command-line arguments", () => {
  for (const args of [
    ["sync", "--token", "secret"],
    ["sync", "--moodle-token=secret"],
    ["sync", "--ics-url", "https://example.test/private"]
  ]) {
    assert.throws(
      () => parseCli(args),
      /token|ics.*environment|credential provider/i
    );
  }
});

test("CLI parser produces bounded commands without business logic", () => {
  assert.deepEqual(
    parseCli(["review", "decide", "change-1", "--expected-version", "2", "--approve"]),
    {
      command: "review.decide",
      input: {
        id: "change-1",
        expectedVersion: 2,
        decision: "approve"
      },
      configArgv: []
    }
  );
  assert.deepEqual(parseCli(["feed", "--limit", "25", "--type", "assignment"]), {
    command: "feed",
    input: { limit: 25, type: "assignment" },
    configArgv: []
  });
});

test("public config reports credential presence without exposing values", () => {
  const config = loadPublicConfig({
    argv: ["--site-url", "https://moodle.example.edu", "--data-dir", ".data"],
    env: {
      MOODLE_CHANGEFEED_TOKEN: "private-token",
      MOODLE_CHANGEFEED_ICS_URL: "https://moodle.example.edu/calendar/private"
    },
    cwd: "/tmp/changefeed-config"
  });

  assert.equal(config.siteUrl, "https://moodle.example.edu");
  assert.equal(config.dataDir, "/tmp/changefeed-config/.data");
  assert.deepEqual(config.credentialStatus, {
    webServiceToken: "configured",
    icsUrl: "configured"
  });
  assert.equal(JSON.stringify(config).includes("private-token"), false);
  assert.equal(JSON.stringify(config).includes("calendar/private"), false);
});

test("non-interactive delivery refuses to mint its own confirmation", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "changefeed-cli-confirm-"));
  const sink = { isTTY: false, write() {} };
  try {
    await assert.rejects(
      runCli({
        argv: [
          "delivery",
          "execute",
          "--plan-hash",
          "a".repeat(64),
          "--site-url",
          "https://moodle.example.edu",
          "--data-dir",
          dataDir
        ],
        env: { MOODLE_CHANGEFEED_WRITE_ENABLED: "true" },
        input: sink,
        output: sink
      }),
      (error) => error.code === "confirmation_provider_required"
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runtime honors enabled domains before normalization", () => {
  const restricted = restrictSnapshotToDomains(
    {
      coursePayloads: [{
        contents: [{ id: 1 }],
        assignments: [{ id: 2, introattachments: [{ id: 3 }] }],
        forums: [{ id: 4 }],
        announcements: [{ id: 5 }]
      }]
    },
    ["assignments"]
  );

  assert.deepEqual(restricted.coursePayloads[0], {
    contents: [],
    assignments: [{ id: 2, introattachments: [], attachments: [] }],
    forums: [],
    announcements: []
  });
});
