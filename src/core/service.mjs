import {
  decodeMoodleCursor,
  encodeMoodleCursor,
  MOODLE_CHANGE_KINDS,
  moodleFeedQuerySchema,
  moodleReviewActionSchema,
  projectMoodleFeed,
  sha256Hex
} from "./contracts.mjs";
import {
  ChangefeedError,
  normalizeChangefeedError
} from "./errors.mjs";
import { withProcessLock } from "./process-lock.mjs";

export { ChangefeedError };

function isoTimestamp(now) {
  return new Date(now).toISOString();
}

function summarizeChanges(changes) {
  const counts = Object.fromEntries(
    MOODLE_CHANGE_KINDS.map((changeKind) => [changeKind, 0])
  );
  for (const change of changes) counts[change.changeKind] += 1;
  return counts;
}

function scopeFor(courseIds) {
  if (courseIds.length === 0) return "all";
  const stable = [...new Set(courseIds.map(String))].sort();
  return stable.length === 1 ? `course:${stable[0]}` : `courses:${stable.join(",")}`;
}

function inScope(object, courseIds) {
  return (
    courseIds.length === 0 ||
    new Set(courseIds.map(String)).has(String(object.course?.id))
  );
}

function restrictNormalizedScope(normalized, courseIds) {
  if (courseIds.length === 0) return normalized;
  const objects = normalized.objects.filter((object) => inScope(object, courseIds));
  const objectIds = new Set(objects.map(({ objectId }) => objectId));
  return {
    objects,
    resources: normalized.resources.filter((resource) =>
      objectIds.has(resource.objectId)
    )
  };
}

function resourceRef(resource) {
  return {
    id: resource.resourceId,
    fileName: resource.metadata?.fileName || "unnamed-file",
    size: resource.metadata?.size ?? null,
    mimeType: resource.metadata?.mimeType ?? null,
    sha256: resource.contentSha256 ?? null,
    cacheStatus: resource.cacheStatus,
    deliveryStatus: "not_delivered"
  };
}

function sha256(value) {
  return sha256Hex(value);
}

function opaqueDeliveryRef(targetType, records) {
  const kind = String(targetType).replaceAll("_", "-");
  const stableRefs = records.map(
    (record) =>
      record.receipt?.externalRef ||
      record.receipt?.fileRef ||
      record.deliveryKey
  );
  return `${kind}-ref:v1:${sha256(JSON.stringify(stableRefs)).slice(0, 24)}`;
}

export class MoodlePipelineService {
  constructor({
    store,
    sourceAdapter,
    normalizer,
    diffEngine,
    resourceCache,
    clock,
    collect,
    normalize,
    diff,
    cache,
    scanLockPath,
    now = () => Date.now(),
    formatGeneratedAt = isoTimestamp
  }) {
    const collectInput = collect || sourceAdapter?.collect?.bind(sourceAdapter);
    const normalizeInput = normalize || normalizer;
    const diffInput = diff || diffEngine;
    const cacheInput = cache || resourceCache;
    const nowInput = clock || now;
    if (
      !store ||
      typeof collectInput !== "function" ||
      typeof normalizeInput !== "function" ||
      typeof diffInput !== "function" ||
      !cacheInput
    ) {
      throw new TypeError("Moodle pipeline dependencies are required");
    }
    this.store = store;
    this.collect = collectInput;
    this.normalize = normalizeInput;
    this.diff = diffInput;
    this.cache = cacheInput;
    this.scanLockPath = scanLockPath;
    this.now = nowInput;
    this.formatGeneratedAt = formatGeneratedAt;
  }

  async scan({ courseIds = [] } = {}) {
    if (
      !Array.isArray(courseIds) ||
      courseIds.length > 100 ||
      courseIds.some(
        (value) =>
          !(
            (typeof value === "string" && value.length >= 1 && value.length <= 80) ||
            (Number.isSafeInteger(value) && value > 0)
          )
      )
    ) {
      throw new TypeError("courseIds must be a bounded array of valid ids");
    }
    const operation = async () => {
        if (
          courseIds.length > 0 &&
          this.store.getStatus().lastCompleteScanAt === null
        ) {
          throw new Error("Moodle 首次基线必须使用全量扫描");
        }
        const startedAt = isoTimestamp(this.now());
        const scope = scopeFor(courseIds);
        const scanId = this.store.beginScan({ scope, startedAt });
        try {
          const raw = await this.collect({ courseIds, capturedAt: startedAt });
          const normalized = restrictNormalizedScope(this.normalize(raw), courseIds);
          const previous = this.store
            .getCurrentObjects()
            .filter((object) => inScope(object, courseIds));
          const statusBefore = this.store.getStatus();
          const baseline =
            statusBefore.lastCompleteScanAt === null && previous.length === 0;
          const scanComplete = raw.complete === true;
          const changes = this.diff(previous, normalized.objects, {
            baseline,
            complete: scanComplete,
            createdAt: startedAt
          });
          const countBefore = this.store.reviewCounts().total;
          this.store.commitScan({
            scanId,
            complete: scanComplete,
            health: raw.health,
            objects: normalized.objects,
            resources: normalized.resources,
            changes,
            completedAt: isoTimestamp(this.now())
          });
          const countAfter = this.store.reviewCounts().total;
          return {
            scanComplete,
            baselineCreated: baseline && scanComplete,
            baselineEstablished: baseline && scanComplete,
            createdReviewItems: countAfter - countBefore,
            observedObjects: normalized.objects.length,
            observedResources: normalized.resources.length,
            changeCounts: summarizeChanges(changes),
            health: { ...(raw.health || {}), scanComplete }
          };
        } catch (error) {
          this.store.failScan({
            scanId,
            health: { status: "error", errorCode: "scan_failed" },
            completedAt: isoTimestamp(this.now())
          });
          throw normalizeChangefeedError(error, { fallbackCode: "scan_failed" });
        }
      };
    return this.scanLockPath
      ? withProcessLock(this.scanLockPath, operation, { label: "Moodle 扫描" })
      : operation();
  }

  #resourcesFor(item) {
    const deliveries = this.store.listDeliveriesForChange?.(item.id) || [];
    const fileDeliveryByResource = new Map(
      deliveries
        .filter(({ targetType }) =>
          targetType === "archive_file" || targetType.endsWith("_file")
        )
        .map((delivery) => [delivery.receipt?.resourceId, delivery])
    );
    const resources = new Map(
      this.store
        .getResources(item.resourceIds || [])
        .map((resource) => [resource.resourceId, resource])
    );
    return (item.resourceIds || [])
      .map((id) => resources.get(id))
      .filter(Boolean)
      .map((resource) => ({
        ...resourceRef(resource),
        deliveryStatus:
          fileDeliveryByResource.get(resource.resourceId)?.status ||
          "not_delivered"
      }));
  }

  #deliveryReceipt(item) {
    const deliveries = this.store.listDeliveriesForChange?.(item.id) || [];
    const task = deliveries.find(
      ({ targetType }) => targetType === "task" || targetType.endsWith("_task")
    );
    const selected = task
      ? [task]
      : deliveries.filter(
          ({ targetType }) =>
            targetType === "archive_file" || targetType.endsWith("_file")
        );
    if (selected.length === 0) return null;
    const allDelivered = selected.every(({ status }) => status === "delivered");
    const anyDelivered = selected.some(({ status }) => status === "delivered");
    const targetType = selected[0].targetType;
    const contentHash =
      selected.length === 1
        ? selected[0].contentHash
        : sha256(JSON.stringify(selected.map(({ contentHash: hash }) => hash)));
    return {
      status: allDelivered ? "delivered" : anyDelivered ? "partial" : selected[0].status,
      targetType,
      deliveredAt: selected
        .map(({ updatedAt }) => updatedAt)
        .sort()
        .at(-1),
      contentHash,
      externalRef: opaqueDeliveryRef(targetType, selected)
    };
  }

  async getFeed(query = {}) {
    const parsed = moodleFeedQuerySchema.parse(query);
    const afterSequence = parsed.cursor
      ? decodeMoodleCursor(parsed.cursor).sequence
      : 0;
    const page = this.store.listReviewItems({
      afterSequence,
      limit: parsed.limit,
      reviewStatus: parsed.reviewStatus,
      courseId: parsed.courseId,
      type: parsed.type
    });
    const status = this.store.getStatus();
    return projectMoodleFeed({
      generatedAt: this.formatGeneratedAt(this.now()),
      cursor:
        page.nextSequence === null
          ? null
          : encodeMoodleCursor(page.nextSequence),
      health: {
        status: status.lastScanHealth?.status || "not_scanned",
        lastCompleteScanAt: status.lastCompleteScanAt,
        scanComplete: status.lastScanComplete
      },
      counts: status.counts,
      items: page.items.map((item) => ({
        id: item.id,
        version: item.version,
        course: item.course,
        type: item.type,
        changeKind: item.changeKind,
        title: item.title,
        dueAt: item.dueAt,
        prioritySignals: item.prioritySignals,
        reviewStatus: item.reviewStatus,
        resourceRefs: this.#resourcesFor(item),
        deliveryReceipt: this.#deliveryReceipt(item)
      }))
    });
  }

  async getReviewItem({ id }) {
    const item = this.store.getReviewItem(id);
    if (!item) throw new ChangefeedError("review_not_found", "Moodle 审核项不存在");
    return {
      id: item.id,
      version: item.version,
      reviewStatus: item.reviewStatus,
      changeKind: item.changeKind,
      course: item.course,
      type: item.type,
      title: item.title,
      dueAt: item.dueAt,
      sourceUpdatedAt: item.sourceUpdatedAt,
      prioritySignals: item.prioritySignals,
      resourceRefs: this.#resourcesFor(item),
      deliveryReceipt: this.#deliveryReceipt(item),
      sourceRef: item.id,
      edited: item.edited
    };
  }

  async cacheResources({ resourceIds = [], reviewItemIds = [] } = {}) {
    if (!Array.isArray(resourceIds) || !Array.isArray(reviewItemIds)) {
      throw new TypeError("resourceIds and reviewItemIds must be arrays");
    }
    const selected = new Set(resourceIds);
    for (const id of reviewItemIds) {
      const item = this.store.getReviewItem(id);
      if (!item) {
        throw new ChangefeedError("review_not_found", "Moodle 审核项不存在");
      }
      for (const resourceId of item.resourceIds || []) selected.add(resourceId);
    }
    if (selected.size === 0) return { items: [], totalBytes: 0 };
    return this.cache.cache({ resourceIds: [...selected].sort() });
  }

  async setReviewDecision(input) {
    const parsed = moodleReviewActionSchema.parse({
      schemaVersion: input?.schemaVersion ?? 1,
      actions: input?.actions
    });
    const ids = parsed.actions.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      throw new ChangefeedError(
        "duplicate_review_id",
        "同一批审核动作包含重复 id"
      );
    }
    let items;
    try {
      items = this.store.setReviewDecisions({
        actions: parsed.actions,
        updatedAt: isoTimestamp(this.now())
      });
    } catch (error) {
      throw normalizeChangefeedError(error, {
        fallbackCode: "review_transition_failed"
      });
    }
    return {
      schemaVersion: 1,
      items: items.map((item) => ({
        id: item.id,
        version: item.version,
        reviewStatus: item.reviewStatus
      }))
    };
  }

  async getStatus() {
    const status = this.store.getStatus();
    return {
      schemaVersion: 1,
      health: {
        status: status.lastScanHealth?.status || "not_scanned",
        lastScanAt: status.lastScanAt,
        lastCompleteScanAt: status.lastCompleteScanAt,
        scanComplete: status.lastScanComplete
      },
      counts: status.counts,
      objectCount: status.objectCount,
      resourceCount: status.resourceCount
    };
  }
}
