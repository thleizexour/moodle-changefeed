import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runDemo } from "../src/cli/main.mjs";

test("anonymous demo reaches one delivered local receipt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "moodle-changefeed-demo-test-"));
  try {
    const result = await runDemo({ fixture: "anonymous/basic", tempDir });
    assert.deepEqual(result, {
      baselineReviewCount: 0,
      changedReviewCount: 2,
      approvedCount: 1,
      deliveredCount: 1,
      duplicateCount: 0
    });
    assert.equal(JSON.stringify(result).includes(tempDir), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
