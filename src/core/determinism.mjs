import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value))) {
    throw new TypeError("canonicalJson accepts JSON-compatible values only");
  }
  return encoded;
}

export function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function canonicalSiteKey(value) {
  let site;
  try {
    site = new URL(value);
  } catch (error) {
    throw new TypeError("Moodle site must be a valid HTTPS URL", { cause: error });
  }
  if (site.protocol !== "https:") {
    throw new TypeError("Moodle site must use HTTPS");
  }
  if (site.username || site.password) {
    throw new TypeError("Moodle site must not contain credentials");
  }
  if (site.search) {
    throw new TypeError("Moodle site must not contain a query");
  }
  if (site.hash) {
    throw new TypeError("Moodle site must not contain a fragment");
  }

  const pathname = site.pathname === "/" ? "" : site.pathname.replace(/\/+$/, "");
  return `${site.origin}${pathname}`;
}
