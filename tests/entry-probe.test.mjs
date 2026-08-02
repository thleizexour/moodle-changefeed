import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MOODLE_ENTRY_STATUSES,
  probeMoodleEntry,
  probeMoodleSitePublic
} from "../src/entry-probe.mjs";
import { REQUIRED_FUNCTIONS } from "../src/adapters/moodle-mobile/index.mjs";
import { auditPublicTree } from "../scripts/public-audit.mjs";

const fixedClock = () => Date.UTC(2030, 0, 2, 3, 4, 5);
const checkedAt = "2030-01-02T03:04:05.000Z";
const resultKeys = ["canScan", "checkedAt", "message", "schemaVersion", "status"];

function mustNotFetch() {
  throw new Error("fetch must not run for local validation");
}

function assertClosedResult(result, status) {
  assert.deepEqual(Object.keys(result).sort(), resultKeys);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, status);
  assert.equal(result.checkedAt, checkedAt);
  assert.doesNotMatch(JSON.stringify(result), /fixture response body|moodle-changefeed-public-probe/i);
}

const SITE = "https://moodle.example.edu/learn";

function moodleFixtureFetch({ calls, siteInfo, courses = [], contents = [] }) {
  return async (_url, options) => {
    const functionName = options.body.get("wsfunction");
    calls.push(functionName);
    if (functionName === "core_webservice_get_site_info") return Response.json(siteInfo);
    if (functionName === "core_enrol_get_users_courses") return Response.json(courses);
    if (functionName === "core_course_get_contents") return Response.json(contents);
    throw new Error(`unexpected function: ${functionName}`);
  };
}

function redirectResponse(location) {
  return new Response(null, { status: 302, headers: { location } });
}

function boundCredentialProvider() {
  return {
    siteKey: SITE,
    async getWebServiceToken() { return "fixture-secret"; }
  };
}

test("anonymous entry probe returns closed local validation results", async () => {
  assert.deepEqual(MOODLE_ENTRY_STATUSES, [
    "site_url_required",
    "authorization_required",
    "compatible",
    "compatible_no_courses",
    "invalid_site_url",
    "unsupported_site",
    "temporarily_unreachable"
  ]);
  assert.deepEqual(
    await probeMoodleSitePublic({ siteUrl: null, fetchImpl: mustNotFetch, clock: fixedClock }),
    {
      schemaVersion: 1,
      status: "site_url_required",
      message: "请输入学校 Moodle 地址",
      canScan: false,
      checkedAt: null
    }
  );
});

test("anonymous entry probe closes null and non-object options", async () => {
  for (const options of [null, 42]) {
    const result = await probeMoodleSitePublic(options);
    assert.deepEqual(Object.keys(result).sort(), resultKeys);
    assert.equal(result.status, "site_url_required");
    assert.equal(result.checkedAt, null);
  }
});

test("anonymous entry probe rejects insecure or credential-bearing site URLs locally", async () => {
  for (const siteUrl of [
    "http://moodle.example.edu",
    "https://user:password@moodle.example.edu",
    "https://moodle.example.edu/?next=fixture",
    "https://moodle.example.edu/#fixture"
  ]) {
    const result = await probeMoodleSitePublic({ siteUrl, fetchImpl: mustNotFetch, clock: fixedClock });
    assert.deepEqual(Object.keys(result).sort(), resultKeys);
    assert.equal(result.status, "invalid_site_url");
    assert.equal(result.checkedAt, null);
  }
});

test("anonymous entry probe closes malformed URL values without fetching", async () => {
  const result = await probeMoodleSitePublic({
    siteUrl: { toString() { throw new Error("fixture response body"); } },
    fetchImpl: mustNotFetch,
    clock: fixedClock
  });

  assert.deepEqual(Object.keys(result).sort(), resultKeys);
  assert.equal(result.status, "invalid_site_url");
  assert.equal(result.checkedAt, null);
});

test("anonymous entry probe recognizes Moodle public config without credentials", async () => {
  const requests = [];
  const result = await probeMoodleSitePublic({
    siteUrl: "https://moodle.example.edu/learn/",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return Response.json([{
        error: false,
        data: { wwwroot: "https://moodle.example.edu/learn", enablemobilewebservice: true }
      }]);
    },
    clock: fixedClock
  });

  assertClosedResult(result, "authorization_required");
  assert.equal(
    requests[0].url,
    "https://moodle.example.edu/learn/lib/ajax/service.php?info=tool_mobile_get_public_config"
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(requests[0].options.credentials, "omit");
  assert.ok(requests[0].options.signal);
  assert.equal(
    requests[0].options.body,
    JSON.stringify([{ index: 0, methodname: "tool_mobile_get_public_config", args: {} }])
  );
  assert.doesNotMatch(String(requests[0].options.body), /token|password|username/i);
});

test("anonymous entry probe recognizes the standard REST invalid-token envelope", async () => {
  const requests = [];
  const result = await probeMoodleSitePublic({
    siteUrl: "https://moodle.example.edu/learn",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1) return new Response("<html>fixture response body</html>");
      return Response.json({ exception: "moodle_exception", errorcode: "invalidtoken" });
    },
    clock: fixedClock
  });

  assertClosedResult(result, "authorization_required");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "https://moodle.example.edu/learn/webservice/rest/server.php");
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.redirect, "manual");
  assert.equal(requests[1].options.credentials, "omit");
  assert.ok(requests[1].options.signal);
  assert.equal(requests[1].options.body.toString(), new URLSearchParams({
    wstoken: "moodle-changefeed-public-probe",
    wsfunction: "core_webservice_get_site_info",
    moodlewsrestformat: "json"
  }).toString());
});

test("anonymous entry probe treats unrecognized HTML as unsupported without exposing it", async () => {
  const result = await probeMoodleSitePublic({
    siteUrl: "https://moodle.example.edu",
    fetchImpl: async () => new Response("<html>fixture response body</html>"),
    clock: fixedClock
  });

  assertClosedResult(result, "unsupported_site");
});

test("anonymous entry probe closes transient HTTP and network failures", async () => {
  const cases = [
    ["rate limited", async () => new Response(null, { status: 429 })],
    ["server failure", async () => new Response(null, { status: 503 })],
    ["network failure", async () => { throw new Error("fixture response body"); }]
  ];

  for (const [name, fetchImpl] of cases) {
    const result = await probeMoodleSitePublic({
      siteUrl: "https://moodle.example.edu",
      fetchImpl,
      clock: fixedClock
    });
    assertClosedResult(result, "temporarily_unreachable");
    assert.equal(result.canScan, false, name);
  }
});

test("anonymous entry probe closes timeout, oversized body, and cross-origin redirects", async () => {
  const cases = [
    [
      "timeout",
      (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("fixture response body")), { once: true });
      }),
      { timeoutMs: 1 }
    ],
    [
      "oversized body",
      async () => new Response("x".repeat(33)),
      { maxBodyBytes: 32 }
    ],
    [
      "cross-origin redirect",
      async () => new Response(null, {
        status: 302,
        headers: { location: "https://other.example.edu/login" }
      }),
      {}
    ],
    [
      "cross-origin redirected response",
      async () => ({
        status: 200,
        redirected: true,
        url: "https://other.example.edu/login",
        headers: new Headers(),
        body: null
      }),
      {}
    ]
  ];

  for (const [name, fetchImpl, options] of cases) {
    const result = await probeMoodleSitePublic({
      siteUrl: "https://moodle.example.edu",
      fetchImpl,
      clock: fixedClock,
      ...options
    });
    assertClosedResult(result, "temporarily_unreachable");
    assert.equal(result.canScan, false, name);
  }
});

test("anonymous entry probe applies its timeout while consuming a response body", async () => {
  const result = await probeMoodleSitePublic({
    siteUrl: "https://moodle.example.edu",
    fetchImpl: async () => ({
      status: 200,
      headers: new Headers(),
      body: {
        getReader() {
          return {
            read: () => new Promise(() => {}),
            cancel: async () => {}
          };
        }
      }
    }),
    timeoutMs: 1,
    clock: fixedClock
  });

  assertClosedResult(result, "temporarily_unreachable");
});

test("anonymous entry probe follows a bounded same-origin HTTPS redirect", async () => {
  const requests = [];
  const result = await probeMoodleSitePublic({
    siteUrl: SITE,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1) {
        return redirectResponse("/learn/lib/ajax/redirected-service.php");
      }
      return Response.json([{
        error: false,
        data: { wwwroot: SITE, enablemobilewebservice: true }
      }]);
    },
    clock: fixedClock
  });

  assertClosedResult(result, "authorization_required");
  assert.deepEqual(requests.map(({ url }) => url), [
    `${SITE}/lib/ajax/service.php?info=tool_mobile_get_public_config`,
    `${SITE}/lib/ajax/redirected-service.php`
  ]);
  assert.ok(requests.every(({ options }) => (
    options.redirect === "manual" && options.credentials === "omit"
  )));
});

test("authenticated entry probe follows a bounded same-origin HTTPS redirect", async () => {
  const requests = [];
  const result = await probeMoodleEntry({
    siteUrl: SITE,
    credentialProvider: boundCredentialProvider(),
    fetchImpl: async (url, options) => {
      const functionName = options.body.get("wsfunction");
      requests.push({ url: String(url), functionName, options });
      if (functionName === "core_webservice_get_site_info" && requests.length === 1) {
        return redirectResponse("/learn/webservice/redirected-server.php");
      }
      if (functionName === "core_webservice_get_site_info") {
        return Response.json({
          userid: 7,
          functions: REQUIRED_FUNCTIONS.map((name) => ({ name }))
        });
      }
      if (functionName === "core_enrol_get_users_courses") {
        return Response.json([{ id: 42 }]);
      }
      if (functionName === "core_course_get_contents") {
        return Response.json([{ id: 1, modules: [] }]);
      }
      throw new Error(`unexpected function: ${functionName}`);
    },
    clock: fixedClock
  });

  assertClosedResult(result, "compatible");
  assert.deepEqual(requests.map(({ url, functionName }) => ({ url, functionName })), [
    {
      url: `${SITE}/webservice/rest/server.php`,
      functionName: "core_webservice_get_site_info"
    },
    {
      url: `${SITE}/webservice/redirected-server.php`,
      functionName: "core_webservice_get_site_info"
    },
    {
      url: `${SITE}/webservice/rest/server.php`,
      functionName: "core_enrol_get_users_courses"
    },
    {
      url: `${SITE}/webservice/rest/server.php`,
      functionName: "core_course_get_contents"
    }
  ]);
  assert.ok(requests.every(({ options }) => options.redirect === "manual"));
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/i);
});

test("anonymous and authenticated probes reject unsafe or excessive redirect chains", async () => {
  const cases = [
    {
      name: "same-origin hop cap",
      expectedCalls: 4,
      response(callCount) {
        return redirectResponse(`/learn/redirect-hop-${callCount}`);
      }
    },
    {
      name: "same-origin loop",
      expectedCalls: 2,
      response(callCount, _url, firstUrl) {
        return redirectResponse(callCount === 1 ? "/learn/redirect-loop" : firstUrl);
      }
    },
    {
      name: "cross-origin redirect",
      expectedCalls: 1,
      response() {
        return redirectResponse("https://other.example.edu/login");
      }
    },
    {
      name: "same-host HTTPS downgrade",
      expectedCalls: 1,
      response() {
        return redirectResponse("http://moodle.example.edu/learn/login");
      }
    }
  ];

  for (const { name, expectedCalls, response } of cases) {
    for (const phase of ["anonymous", "authenticated"]) {
      let callCount = 0;
      let firstUrl;
      const fetchImpl = async (url) => {
        callCount += 1;
        firstUrl ||= String(url);
        return response(callCount, String(url), firstUrl);
      };
      const result = phase === "anonymous"
        ? await probeMoodleSitePublic({ siteUrl: SITE, fetchImpl, clock: fixedClock })
        : await probeMoodleEntry({
          siteUrl: SITE,
          credentialProvider: boundCredentialProvider(),
          fetchImpl,
          clock: fixedClock
        });

      assertClosedResult(result, "temporarily_unreachable");
      assert.equal(callCount, expectedCalls, `${phase}: ${name}`);
    }
  }
});

test("authenticated entry probe verifies only the three core reads", async () => {
  const calls = [];
  const result = await probeMoodleEntry({
    siteUrl: `${SITE}/`,
    credentialProvider: {
      siteKey: SITE,
      async getWebServiceToken() { return "fixture-secret"; }
    },
    fetchImpl: moodleFixtureFetch({
      calls,
      siteInfo: {
        userid: 7,
        functions: [
          ...REQUIRED_FUNCTIONS.map((name) => ({ name })),
          { name: "mod_quiz_get_quizzes_by_courses" }
        ]
      },
      courses: [{ id: 42 }],
      contents: [{ id: 1, modules: [] }]
    }),
    clock: fixedClock
  });

  assertClosedResult(result, "compatible");
  assert.equal(result.canScan, true);
  assert.deepEqual(calls, REQUIRED_FUNCTIONS);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|functions|userid|courseid/i);
});

test("authenticated entry probe remains compatible when optional functions are absent", async () => {
  const calls = [];
  const result = await probeMoodleEntry({
    siteUrl: SITE,
    credentialProvider: {
      siteKey: SITE,
      async getWebServiceToken() { return "fixture-secret"; }
    },
    fetchImpl: moodleFixtureFetch({
      calls,
      siteInfo: { userid: 7, functions: REQUIRED_FUNCTIONS.map((name) => ({ name })) },
      courses: [{ id: 42 }],
      contents: [{ id: 1, modules: [] }]
    }),
    clock: fixedClock
  });

  assertClosedResult(result, "compatible");
  assert.equal(result.canScan, true);
  assert.deepEqual(calls, REQUIRED_FUNCTIONS);
  assert.doesNotMatch(JSON.stringify(result), /optional|missing|mod_assign|mod_forum|mod_quiz/i);
});

test("authenticated entry probe accepts an account with no visible courses", async () => {
  const calls = [];
  const result = await probeMoodleEntry({
    siteUrl: SITE,
    credentialProvider: {
      siteKey: SITE,
      async getWebServiceToken() { return "fixture-secret"; }
    },
    fetchImpl: moodleFixtureFetch({
      calls,
      siteInfo: { userid: 7, functions: REQUIRED_FUNCTIONS.map((name) => ({ name })) },
      courses: []
    }),
    clock: fixedClock
  });

  assertClosedResult(result, "compatible_no_courses");
  assert.equal(result.canScan, true);
  assert.deepEqual(calls, REQUIRED_FUNCTIONS.slice(0, 2));
});

test("authenticated entry probe treats explicitly hidden-only courses as no visible courses", async () => {
  const calls = [];
  const result = await probeMoodleEntry({
    siteUrl: SITE,
    credentialProvider: boundCredentialProvider(),
    fetchImpl: moodleFixtureFetch({
      calls,
      siteInfo: { userid: 7, functions: REQUIRED_FUNCTIONS.map((name) => ({ name })) },
      courses: [{ id: 11, visible: false }, { id: 12, visible: 0 }],
      contents: [{ id: 1, modules: [] }]
    }),
    clock: fixedClock
  });

  assertClosedResult(result, "compatible_no_courses");
  assert.deepEqual(calls, REQUIRED_FUNCTIONS.slice(0, 2));
});

test("authenticated entry probe reads the first visible course after hidden entries", async () => {
  const contentCourseIds = [];
  const result = await probeMoodleEntry({
    siteUrl: SITE,
    credentialProvider: boundCredentialProvider(),
    fetchImpl: async (_url, options) => {
      const functionName = options.body.get("wsfunction");
      if (functionName === "core_webservice_get_site_info") {
        return Response.json({
          userid: 7,
          functions: REQUIRED_FUNCTIONS.map((name) => ({ name }))
        });
      }
      if (functionName === "core_enrol_get_users_courses") {
        return Response.json([
          { id: 11, visible: false },
          { id: 22, visible: true },
          { id: 33 }
        ]);
      }
      if (functionName === "core_course_get_contents") {
        contentCourseIds.push(options.body.get("courseid"));
        return Response.json([{ id: 1, modules: [] }]);
      }
      throw new Error(`unexpected function: ${functionName}`);
    },
    clock: fixedClock
  });

  assertClosedResult(result, "compatible");
  assert.deepEqual(contentCourseIds, ["22"]);
});

test("authenticated entry probe rejects a site missing one core read", async () => {
  const calls = [];
  const result = await probeMoodleEntry({
    siteUrl: SITE,
    credentialProvider: {
      siteKey: SITE,
      async getWebServiceToken() { return "fixture-secret"; }
    },
    fetchImpl: moodleFixtureFetch({
      calls,
      siteInfo: { userid: 7, functions: REQUIRED_FUNCTIONS.slice(0, 2).map((name) => ({ name })) }
    }),
    clock: fixedClock
  });

  assertClosedResult(result, "unsupported_site");
  assert.deepEqual(calls, ["core_webservice_get_site_info"]);
});

test("authenticated entry probe maps invalid or expired credentials to authorization", async () => {
  for (const errorCode of ["invalidtoken", "tokenexpired"]) {
    const result = await probeMoodleEntry({
      siteUrl: SITE,
      credentialProvider: {
        siteKey: SITE,
        async getWebServiceToken() { return "fixture-secret"; }
      },
      fetchImpl: async () => Response.json({
        exception: "moodle_exception",
        errorcode: errorCode,
        message: "fixture response body"
      }),
      clock: fixedClock
    });

    assertClosedResult(result, "authorization_required");
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture response body/i);
  }
});

test("authenticated entry probe closes transient service failures", async () => {
  const result = await probeMoodleEntry({
    siteUrl: SITE,
    credentialProvider: {
      siteKey: SITE,
      async getWebServiceToken() { return "fixture-secret"; }
    },
    fetchImpl: async () => new Response(null, { status: 503 }),
    clock: fixedClock
  });

  assertClosedResult(result, "temporarily_unreachable");
});

test("authenticated entry probe rejects non-JSON protocol responses without exposing them", async () => {
  const result = await probeMoodleEntry({
    siteUrl: SITE,
    credentialProvider: {
      siteKey: SITE,
      async getWebServiceToken() { return "fixture-secret"; }
    },
    fetchImpl: async () => new Response("<html>fixture response body</html>"),
    clock: fixedClock
  });

  assertClosedResult(result, "unsupported_site");
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture response body/i);
});

test("entry probe never requests credentials bound to a different site", async () => {
  const requests = [];
  const result = await probeMoodleEntry({
    siteUrl: "https://foreign.example.edu/learn/",
    credentialProvider: {
      siteKey: SITE,
      async getWebServiceToken() { throw new Error("credential getter must not run"); }
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return Response.json([{ error: false, data: { enablemobilewebservice: true } }]);
    },
    clock: fixedClock
  });

  assertClosedResult(result, "authorization_required");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.credentials, "omit");
  assert.doesNotMatch(String(requests[0].options.body), /fixture-secret|wstoken/i);
});

test("public release audit declares the entry probe implementation and test", async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await auditPublicTree({ root: packageRoot });

  assert.deepEqual(
    result.findings.filter(({ path: findingPath }) => [
      "src/entry-probe.mjs",
      "tests/entry-probe.test.mjs"
    ].includes(findingPath)),
    []
  );
});
