import assert from "node:assert/strict";
import test from "node:test";

import {
  MoodleIcsAdapter,
  parseMoodleIcs
} from "../src/adapters/moodle-ics/index.mjs";

const CALENDAR = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:example-1
SUMMARY:Example deadline
DTSTART:20260801T120000Z
END:VEVENT
END:VCALENDAR`;

test("ICS parsing is deterministic and excludes subscription coordinates", () => {
  assert.deepEqual(parseMoodleIcs(CALENDAR), [
    {
      externalId: "moodle:example-1",
      uid: "example-1",
      recurrenceId: null,
      title: "Example deadline",
      description: "",
      start: "2026-08-01T12:00:00Z",
      end: null,
      startTimeZone: null,
      endTimeZone: null,
      sourceUrl: ""
    }
  ]);
});

test("ICS adapter obtains a private URL from its provider without returning it", async () => {
  const privateUrl = "https://moodle.example.edu/calendar/export.php?token=private";
  const adapter = new MoodleIcsAdapter({
    credentialProvider: { async getIcsUrl() { return privateUrl; } },
    fetchImpl: async (url, options) => {
      assert.equal(url, privateUrl);
      assert.equal(options.redirect, "manual");
      return { ok: true, status: 200, text: async () => CALENDAR };
    }
  });
  const result = await adapter.collect();
  assert.equal(result.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /export\.php|private/);
});
