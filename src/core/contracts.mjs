import { z } from "zod";

import {
  canonicalJson,
  canonicalSiteKey,
  sha256Hex
} from "./determinism.mjs";

export { canonicalJson, canonicalSiteKey, sha256Hex };

export const MOODLE_FEED_SCHEMA_VERSION = 1;

export const MOODLE_CHANGE_KINDS = Object.freeze([
  "added",
  "metadata_changed",
  "content_changed",
  "possibly_missing",
  "access_lost",
  "unchanged"
]);

export const MOODLE_REVIEW_STATUSES = Object.freeze([
  "pending",
  "approved",
  "ignored",
  "deferred",
  "ready_for_delivery",
  "delivered",
  "failed"
]);

const reviewDecisions = ["approve", "ignore", "defer", "resume"];
const moodleItemTypes = ["assignment", "announcement", "resource"];

function siteFingerprint(siteUrl) {
  return sha256Hex(canonicalSiteKey(siteUrl)).slice(0, 16);
}

export function makeMoodleObjectId({ siteUrl, courseId, type, sourceId }) {
  return [
    "moodle-object",
    "v1",
    siteFingerprint(siteUrl),
    courseId,
    type,
    sourceId
  ]
    .map(String)
    .join(":");
}

export function makeMoodleResourceId({ siteUrl, courseId, sourceFileId }) {
  return [
    "moodle-resource",
    "v1",
    siteFingerprint(siteUrl),
    courseId,
    sourceFileId
  ]
    .map(String)
    .join(":");
}

export function makeMoodleChangeId(input) {
  const digest = sha256Hex(
    canonicalJson({
      objectId: input.objectId,
      beforeHash: input.beforeHash || null,
      afterHash: input.afterHash || null,
      changeKind: input.changeKind
    })
  ).slice(0, 32);
  return `moodle-change:v1:${digest}`;
}

const cursorPayloadSchema = z
  .object({
    schemaVersion: z.literal(MOODLE_FEED_SCHEMA_VERSION),
    sequence: z.number().int().nonnegative()
  })
  .strict();

export function encodeMoodleCursor(sequence) {
  const payload = cursorPayloadSchema.parse({
    schemaVersion: MOODLE_FEED_SCHEMA_VERSION,
    sequence
  });
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeMoodleCursor(cursor) {
  try {
    if (
      typeof cursor !== "string" ||
      cursor.length === 0 ||
      cursor.length > 256 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)
    ) {
      throw new Error("invalid cursor string");
    }
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const payload = cursorPayloadSchema.parse(JSON.parse(decoded));
    if (encodeMoodleCursor(payload.sequence) !== cursor) {
      throw new Error("invalid cursor encoding");
    }
    return payload;
  } catch (error) {
    throw new Error("Invalid Moodle cursor", { cause: error });
  }
}

export const moodleFeedQuerySchema = z
  .object({
    cursor: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    reviewStatus: z.enum(MOODLE_REVIEW_STATUSES).optional(),
    courseId: z.string().max(80).optional(),
    type: z.enum(moodleItemTypes).optional()
  })
  .strict();

export const moodleReviewActionSchema = z
  .object({
    schemaVersion: z.literal(MOODLE_FEED_SCHEMA_VERSION),
    actions: z
      .array(
        z
          .object({
            id: z.string().min(16).max(300),
            expectedVersion: z.number().int().positive(),
            decision: z.enum(reviewDecisions)
          })
          .strict()
      )
      .min(1)
      .max(100)
  })
  .strict();

function projectCourse(course = {}) {
  return {
    id: course.id,
    code: course.code ?? null,
    name: course.name,
    term: course.term ?? null
  };
}

function projectResourceRef(resource = {}) {
  return {
    id: resource.id,
    fileName: resource.fileName,
    size: resource.size,
    mimeType: resource.mimeType,
    sha256: resource.sha256 ?? null,
    cacheStatus: resource.cacheStatus,
    deliveryStatus: resource.deliveryStatus
  };
}

function projectDeliveryReceipt(receipt) {
  if (!receipt) return null;
  return {
    status: receipt.status,
    targetType: receipt.targetType,
    deliveredAt: receipt.deliveredAt,
    contentHash: receipt.contentHash,
    externalRef: receipt.externalRef
  };
}

function projectHealth(health = {}) {
  return {
    status: health.status,
    lastCompleteScanAt: health.lastCompleteScanAt ?? null,
    scanComplete: Boolean(health.scanComplete)
  };
}

function projectCounts(counts = {}) {
  return {
    total: counts.total,
    pending: counts.pending,
    approved: counts.approved,
    ignored: counts.ignored,
    deferred: counts.deferred,
    readyForDelivery: counts.readyForDelivery,
    delivered: counts.delivered,
    failed: counts.failed
  };
}

export function projectMoodleFeed(input) {
  return {
    schemaVersion: MOODLE_FEED_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    cursor: input.cursor,
    health: projectHealth(input.health),
    counts: projectCounts(input.counts),
    items: (input.items || []).map((item) => ({
      id: item.id,
      version: item.version,
      course: projectCourse(item.course),
      type: item.type,
      changeKind: item.changeKind,
      title: item.title,
      dueAt: item.dueAt ?? null,
      prioritySignals: [...(item.prioritySignals || [])],
      reviewStatus: item.reviewStatus,
      resourceRefs: (item.resourceRefs || []).map(projectResourceRef),
      deliveryReceipt: projectDeliveryReceipt(item.deliveryReceipt)
    }))
  };
}
