import { canonicalSiteKey } from "./core/contracts.mjs";
import {
  MoodleMobileClient,
  MoodleWebServiceError,
  REQUIRED_FUNCTIONS
} from "./adapters/moodle-mobile/index.mjs";

export const MOODLE_ENTRY_STATUSES = Object.freeze([
  "site_url_required",
  "authorization_required",
  "compatible",
  "compatible_no_courses",
  "invalid_site_url",
  "unsupported_site",
  "temporarily_unreachable"
]);

const ENTRY_DETAILS = Object.freeze({
  site_url_required: { message: "请输入学校 Moodle 地址", canScan: false },
  authorization_required: { message: "已识别 Moodle，请完成学校登录授权", canScan: false },
  compatible: { message: "连接成功，可以开始使用", canScan: true },
  compatible_no_courses: { message: "连接成功，当前账号暂无可见课程", canScan: true },
  invalid_site_url: { message: "Moodle 地址无效，请检查后重试", canScan: false },
  unsupported_site: { message: "该站点未开放项目所需的 Moodle 读取能力", canScan: false },
  temporarily_unreachable: { message: "暂时无法连接学校 Moodle，请稍后重试", canScan: false }
});

const PUBLIC_CONFIG_BODY = JSON.stringify([
  { index: 0, methodname: "tool_mobile_get_public_config", args: {} }
]);

class ProbeTimeoutError extends Error {}
class ProbeBodyLimitError extends Error {}

const MAX_REDIRECT_HOPS = 3;

function hasStatus(value) {
  return Object.hasOwn(ENTRY_DETAILS, value);
}

function checkedAt(clock) {
  try {
    const value = new Date(clock()).toISOString();
    return value;
  } catch {
    return null;
  }
}

export function entryProbeResult(status, { clock = () => Date.now() } = {}) {
  const detail = hasStatus(status)
    ? ENTRY_DETAILS[status]
    : ENTRY_DETAILS.temporarily_unreachable;
  const localResult = status === "site_url_required" || status === "invalid_site_url";

  return {
    schemaVersion: 1,
    status: hasStatus(status) ? status : "temporarily_unreachable",
    message: detail.message,
    canScan: detail.canScan,
    checkedAt: localResult ? null : checkedAt(clock)
  };
}

function normalizedTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
}

async function readLimitedText(response, maxBodyBytes) {
  const limit = Number.isFinite(maxBodyBytes) && maxBodyBytes >= 0 ? maxBodyBytes : 262144;
  if (!response?.body) return "";

  const reader = response.body.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit) throw new ProbeBodyLimitError();
    return text;
  }

  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) throw new ProbeBodyLimitError();
      chunks.push(value);
    }
  } finally {
    if (byteLength > limit) await reader.cancel().catch(() => {});
  }

  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function responseJson(response, maxBodyBytes) {
  const text = await readLimitedText(response, maxBodyBytes);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isTransientResponse(response) {
  return response?.status === 429 || response?.status >= 500;
}

function redirectTarget(response, currentUrl, expectedOrigin) {
  if (!response) return { kind: "none" };
  if (response.redirected) return { kind: "rejected" };
  if (response.url) {
    try {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== "https:" || finalUrl.origin !== expectedOrigin) {
        return { kind: "rejected" };
      }
    } catch {
      return { kind: "rejected" };
    }
  }
  if (response.status < 300 || response.status > 399) return { kind: "none" };
  const location = response.headers?.get?.("location");
  if (!location) return { kind: "rejected" };
  try {
    const target = new URL(location, currentUrl);
    if (target.protocol !== "https:" || target.origin !== expectedOrigin) {
      return { kind: "rejected" };
    }
    return { kind: "follow", url: target.toString() };
  } catch {
    return { kind: "rejected" };
  }
}

function isMoodleAjaxEnvelope(payload) {
  const first = Array.isArray(payload) ? payload[0] : null;
  return Boolean(
    first &&
      typeof first === "object" &&
      typeof first.error === "boolean" &&
      (Object.hasOwn(first, "data") || Object.hasOwn(first, "exception"))
  );
}

function isInvalidTokenEnvelope(payload) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      payload.exception === "moodle_exception" &&
      payload.errorcode === "invalidtoken"
  );
}

function publicConfigUrl(siteKey) {
  const url = new URL(`${siteKey}/lib/ajax/service.php`);
  url.searchParams.set("info", "tool_mobile_get_public_config");
  return url.toString();
}

function restUrl(siteKey) {
  return new URL(`${siteKey}/webservice/rest/server.php`).toString();
}

async function requestJson({ fetchImpl, url, options, timeoutMs, maxBodyBytes, origin }) {
  const controller = new AbortController();
  let timer;
  const operation = (async () => {
    let currentUrl = new URL(url).toString();
    const visited = new Set([currentUrl]);
    for (let redirectHops = 0; ; redirectHops += 1) {
      const response = await fetchImpl(currentUrl, {
        ...options,
        redirect: "manual",
        signal: controller.signal
      });
      if (isTransientResponse(response)) return { kind: "transient" };

      const redirect = redirectTarget(response, currentUrl, origin);
      if (redirect.kind === "rejected") return { kind: "transient" };
      if (redirect.kind === "follow") {
        if (redirectHops >= MAX_REDIRECT_HOPS || visited.has(redirect.url)) {
          return { kind: "transient" };
        }
        visited.add(redirect.url);
        currentUrl = redirect.url;
        continue;
      }
      return { kind: "json", payload: await responseJson(response, maxBodyBytes) };
    }
  })();
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProbeTimeoutError());
    }, normalizedTimeout(timeoutMs));
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function boundedMoodleFetch({ fetchImpl, siteKey, timeoutMs, maxBodyBytes }) {
  const origin = new URL(siteKey).origin;
  return async (url, options) => {
    const response = await requestJson({
      fetchImpl,
      url,
      options,
      timeoutMs,
      maxBodyBytes,
      origin
    });
    if (response.kind === "transient") throw new ProbeTimeoutError();
    return {
      ok: true,
      status: 200,
      redirected: false,
      headers: new Headers(),
      async json() {
        if (response.payload === null) throw new SyntaxError("non-JSON response");
        return response.payload;
      }
    };
  };
}

const AUTHORIZATION_ERROR_CODES = new Set(["invalidtoken", "tokenexpired"]);

function authenticatedErrorStatus(error) {
  if (
    error instanceof MoodleWebServiceError &&
    AUTHORIZATION_ERROR_CODES.has(error.errorCode)
  ) {
    return "authorization_required";
  }
  if (
    error instanceof MoodleWebServiceError &&
    (error.errorCode || error.message.includes("non-JSON"))
  ) {
    return "unsupported_site";
  }
  return "temporarily_unreachable";
}

async function verifyMoodleCoreAccessWithToken({
  siteKey,
  token,
  fetchImpl,
  timeoutMs,
  maxBodyBytes,
  clock
}) {
  const client = new MoodleMobileClient({
    siteKey,
    credentialProvider: { async getWebServiceToken() { return token; } },
    fetchImpl: boundedMoodleFetch({ fetchImpl, siteKey, timeoutMs, maxBodyBytes })
  });

  try {
    const siteInfo = await client.getSiteInfo();
    const availableFunctions = new Set(
      Array.isArray(siteInfo?.functions)
        ? siteInfo.functions.map((entry) => entry?.name).filter((name) => typeof name === "string")
        : []
    );
    if (
      !REQUIRED_FUNCTIONS.every((functionName) => availableFunctions.has(functionName)) ||
      siteInfo?.userid === undefined ||
      siteInfo?.userid === null
    ) {
      return entryProbeResult("unsupported_site", { clock });
    }

    const courses = await client.getUserCourses(siteInfo.userid);
    if (!Array.isArray(courses)) {
      return entryProbeResult("unsupported_site", { clock });
    }
    const visibleCourses = courses.filter((course) => (
      course?.visible !== false && course?.visible !== 0
    ));
    if (visibleCourses.length === 0) {
      return entryProbeResult("compatible_no_courses", { clock });
    }
    if (visibleCourses[0]?.id === undefined || visibleCourses[0]?.id === null) {
      return entryProbeResult("unsupported_site", { clock });
    }

    const contents = await client.getCourseContents(visibleCourses[0].id);
    return entryProbeResult(
      Array.isArray(contents) ? "compatible" : "unsupported_site",
      { clock }
    );
  } catch (error) {
    return entryProbeResult(authenticatedErrorStatus(error), { clock });
  }
}

function siteKeyForProbe(siteUrl) {
  if (
    siteUrl === null ||
    siteUrl === undefined ||
    (typeof siteUrl === "string" && siteUrl.trim() === "")
  ) {
    return { status: "site_url_required", siteKey: null };
  }
  try {
    return { status: null, siteKey: canonicalSiteKey(siteUrl) };
  } catch {
    return { status: "invalid_site_url", siteKey: null };
  }
}

async function readBoundToken(siteKey, credentialProvider) {
  if (
    credentialProvider?.siteKey !== siteKey ||
    typeof credentialProvider?.getWebServiceToken !== "function"
  ) {
    return { kind: "unbound", token: null };
  }
  try {
    const token = await credentialProvider.getWebServiceToken();
    return typeof token === "string" && token.length > 0
      ? { kind: "available", token }
      : { kind: "missing", token: null };
  } catch {
    return { kind: "failed", token: null };
  }
}

export async function verifyMoodleCoreAccess(input = {}) {
  const options = input && typeof input === "object" ? input : {};
  const {
    siteUrl,
    credentialProvider,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5000,
    maxBodyBytes = 262144,
    clock = () => Date.now()
  } = options;
  const resolved = siteKeyForProbe(siteUrl);
  if (resolved.status) return entryProbeResult(resolved.status, { clock });
  if (typeof fetchImpl !== "function") {
    return entryProbeResult("temporarily_unreachable", { clock });
  }

  const credential = await readBoundToken(resolved.siteKey, credentialProvider);
  if (credential.kind === "unbound" || credential.kind === "missing") {
    return entryProbeResult("authorization_required", { clock });
  }
  if (credential.kind === "failed") {
    return entryProbeResult("temporarily_unreachable", { clock });
  }
  return verifyMoodleCoreAccessWithToken({
    siteKey: resolved.siteKey,
    token: credential.token,
    fetchImpl,
    timeoutMs,
    maxBodyBytes,
    clock
  });
}

export async function probeMoodleEntry(input = {}) {
  const options = input && typeof input === "object" ? input : {};
  const {
    siteUrl,
    credentialProvider,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5000,
    maxBodyBytes = 262144,
    clock = () => Date.now()
  } = options;
  const resolved = siteKeyForProbe(siteUrl);
  if (resolved.status) return entryProbeResult(resolved.status, { clock });

  const credential = await readBoundToken(resolved.siteKey, credentialProvider);
  if (credential.kind === "available") {
    if (typeof fetchImpl !== "function") {
      return entryProbeResult("temporarily_unreachable", { clock });
    }
    return verifyMoodleCoreAccessWithToken({
      siteKey: resolved.siteKey,
      token: credential.token,
      fetchImpl,
      timeoutMs,
      maxBodyBytes,
      clock
    });
  }
  if (credential.kind === "failed") {
    return entryProbeResult("temporarily_unreachable", { clock });
  }
  return probeMoodleSitePublic({
    siteUrl: resolved.siteKey,
    fetchImpl,
    timeoutMs,
    maxBodyBytes,
    clock
  });
}

export async function probeMoodleSitePublic(input = {}) {
  const options = input && typeof input === "object" ? input : {};
  const {
    siteUrl,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5000,
    maxBodyBytes = 262144,
    clock = () => Date.now()
  } = options;
  if (
    siteUrl === null ||
    siteUrl === undefined ||
    (typeof siteUrl === "string" && siteUrl.trim() === "")
  ) {
    return entryProbeResult("site_url_required", { clock });
  }

  let siteKey;
  try {
    siteKey = canonicalSiteKey(siteUrl);
  } catch {
    return entryProbeResult("invalid_site_url", { clock });
  }

  if (typeof fetchImpl !== "function") {
    return entryProbeResult("temporarily_unreachable", { clock });
  }

  const origin = new URL(siteKey).origin;
  try {
    const publicConfig = await requestJson({
      fetchImpl,
      url: publicConfigUrl(siteKey),
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: PUBLIC_CONFIG_BODY,
        redirect: "manual",
        credentials: "omit"
      },
      timeoutMs,
      maxBodyBytes,
      origin
    });
    if (publicConfig.kind === "transient") {
      return entryProbeResult("temporarily_unreachable", { clock });
    }
    if (isMoodleAjaxEnvelope(publicConfig.payload)) {
      return entryProbeResult("authorization_required", { clock });
    }

    const rest = await requestJson({
      fetchImpl,
      url: restUrl(siteKey),
      options: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({
          wstoken: "moodle-changefeed-public-probe",
          wsfunction: "core_webservice_get_site_info",
          moodlewsrestformat: "json"
        }),
        redirect: "manual",
        credentials: "omit"
      },
      timeoutMs,
      maxBodyBytes,
      origin
    });
    if (rest.kind === "transient") {
      return entryProbeResult("temporarily_unreachable", { clock });
    }
    return entryProbeResult(
      isInvalidTokenEnvelope(rest.payload) ? "authorization_required" : "unsupported_site",
      { clock }
    );
  } catch {
    return entryProbeResult("temporarily_unreachable", { clock });
  }
}
