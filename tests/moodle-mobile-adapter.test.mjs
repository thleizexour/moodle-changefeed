import assert from "node:assert/strict";
import test from "node:test";

import {
  MoodleMobileClient,
  MoodleMobileSourceAdapter,
  OPTIONAL_FUNCTIONS,
  REQUIRED_FUNCTIONS
} from "../src/adapters/moodle-mobile/index.mjs";

test("client rejects every function outside the v0.1 read allowlist", async () => {
  let fetchCalls = 0;
  const client = new MoodleMobileClient({
    siteKey: "https://moodle.example.edu",
    credentialProvider: { async getWebServiceToken() { return "secret"; } },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }
  });

  await assert.rejects(
    client.call("mod_assign_save_submission", {}),
    (error) => error.code === "moodle_function_not_allowed"
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual(REQUIRED_FUNCTIONS, [
    "core_webservice_get_site_info",
    "core_enrol_get_users_courses",
    "core_course_get_contents"
  ]);
  assert.deepEqual(OPTIONAL_FUNCTIONS, [
    "core_calendar_get_calendar_events",
    "mod_assign_get_assignments",
    "mod_forum_get_forums_by_courses",
    "mod_forum_get_forum_discussions",
    "mod_quiz_get_quizzes_by_courses"
  ]);
});

test("client uses provider credentials without exposing token or following redirects", async () => {
  const requests = [];
  const token = "private-token-value";
  const client = new MoodleMobileClient({
    siteKey: "https://moodle.example.edu/learn",
    credentialProvider: { async getWebServiceToken() { return token; } },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: false, status: 302, redirected: false, headers: new Headers() };
    }
  });

  await assert.rejects(
    client.fetchResource({
      pathname: "/learn/webservice/pluginfile.php/1/a.pdf",
      forcedownload: false
    }),
    (error) =>
      error.code === "moodle_redirect_rejected" &&
      !error.message.includes(token) &&
      !JSON.stringify(error.details).includes(token)
  );
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(new URL(requests[0].url).searchParams.get("token"), token);
});

test("client standardizes unavailable optional Moodle capabilities without exposing server text", async () => {
  const client = new MoodleMobileClient({
    siteKey: "https://moodle.example.edu",
    credentialProvider: { async getWebServiceToken() { return "secret"; } },
    fetchImpl: async () => Response.json({
      exception: "dml_missing_record_exception",
      errorcode: "wsfunctionnotavailable",
      message: "sensitive server text that must not escape"
    })
  });

  await assert.rejects(
    client.call("mod_assign_get_assignments", { courseids: [42] }),
    (error) =>
      error.code === "capability_unavailable" &&
      error.errorCode === "wsfunctionnotavailable" &&
      !error.message.includes("sensitive server text that must not escape")
  );
});

test("client preserves non-optional and transient Moodle failures", async () => {
  const unavailableCoreClient = new MoodleMobileClient({
    siteKey: "https://moodle.example.edu",
    credentialProvider: { async getWebServiceToken() { return "secret"; } },
    fetchImpl: async () => Response.json({
      exception: "dml_missing_record_exception",
      errorcode: "wsfunctionnotavailable",
      message: "sensitive server text that must not escape"
    })
  });
  await assert.rejects(
    unavailableCoreClient.getSiteInfo(),
    (error) =>
      error.code === "moodle_request_failed" &&
      error.errorCode === "wsfunctionnotavailable" &&
      !error.message.includes("sensitive server text that must not escape")
  );

  for (const [name, response] of [
    ["invalid parameters", Response.json({ exception: "invalid_parameter_exception", errorcode: "invalidparameter" })],
    ["rate limited", new Response(null, { status: 429 })],
    ["server failure", new Response(null, { status: 503 })]
  ]) {
    const client = new MoodleMobileClient({
      siteKey: "https://moodle.example.edu",
      credentialProvider: { async getWebServiceToken() { return "secret"; } },
      fetchImpl: async () => response
    });
    await assert.rejects(
      client.call("mod_assign_get_assignments", { courseids: [42] }),
      (error) => error.code === "moodle_request_failed",
      name
    );
  }

  const timeoutClient = new MoodleMobileClient({
    siteKey: "https://moodle.example.edu",
    credentialProvider: { async getWebServiceToken() { return "secret"; } },
    fetchImpl: async () => { throw new Error("timeout"); }
  });
  await assert.rejects(
    timeoutClient.call("mod_assign_get_assignments", { courseids: [42] }),
    (error) => error.code === "moodle_request_failed"
  );
});

test("optional failures degrade only their Moodle domain", async () => {
  const client = {
    siteKey: "https://moodle.example.edu",
    async getSiteInfo() { return { userid: 7 }; },
    async getUserCourses() {
      return [{ id: 42, shortname: "EXAMPLE42", fullname: "Example course" }];
    },
    async getCourseContents() { return [{ id: 1, modules: [] }]; },
    async call(functionName) {
      if (functionName === "mod_assign_get_assignments") {
        const error = new Error("not available");
        error.errorCode = "notavailable";
        throw error;
      }
      if (functionName === "mod_forum_get_forums_by_courses") return [];
      throw new Error(`unexpected ${functionName}`);
    }
  };
  const adapter = new MoodleMobileSourceAdapter({ client, retryDelayMs: 0 });
  const result = await adapter.collect({ capturedAt: "2026-08-01T00:00:00.000Z" });

  assert.equal(result.complete, false);
  assert.deepEqual(result.health.completeness, {
    resources: true,
    assignments: false,
    announcements: true
  });
  assert.equal(result.siteKey, "https://moodle.example.edu");
  assert.doesNotMatch(JSON.stringify(result), /private-token|wstoken/);
});

test("source adapter continues after an unavailable optional capability", async () => {
  const client = new MoodleMobileClient({
    siteKey: "https://moodle.example.edu",
    credentialProvider: { async getWebServiceToken() { return "secret"; } },
    fetchImpl: async (_url, options) => {
      switch (options.body.get("wsfunction")) {
        case "core_webservice_get_site_info":
          return Response.json({ userid: 7 });
        case "core_enrol_get_users_courses":
          return Response.json([{ id: 42, shortname: "EXAMPLE42", fullname: "Example course" }]);
        case "core_course_get_contents":
          return Response.json([{ id: 1, modules: [] }]);
        case "mod_assign_get_assignments":
          return Response.json({
            exception: "dml_missing_record_exception",
            errorcode: "wsfunctionnotavailable",
            message: "sensitive server text that must not escape"
          });
        case "mod_forum_get_forums_by_courses":
          return Response.json([]);
        default:
          throw new Error("unexpected function");
      }
    }
  });

  const result = await new MoodleMobileSourceAdapter({ client, retryDelayMs: 0 }).collect({
    capturedAt: "2026-08-01T00:00:00.000Z"
  });

  assert.equal(result.complete, false);
  assert.deepEqual(result.health.completeness, {
    resources: true,
    assignments: false,
    announcements: true
  });
  assert.deepEqual(result.health.errors, [{
    courseId: "42",
    errorCode: "capability_unavailable"
  }]);
  assert.doesNotMatch(JSON.stringify(result), /sensitive server text that must not escape/);
});
