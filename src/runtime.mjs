import path from "node:path";

import { LocalArchiveAdapter } from "./adapters/local-archive/index.mjs";
import { MoodleIcsAdapter } from "./adapters/moodle-ics/index.mjs";
import {
  MoodleMobileClient,
  MoodleMobileSourceAdapter
} from "./adapters/moodle-mobile/index.mjs";
import { MoodleResourceCache } from "./cache/resource-cache.mjs";
import { MoodleDeliveryCoordinator } from "./core/delivery-coordinator.mjs";
import { diffMoodleObjects } from "./core/diff.mjs";
import { MoodlePipelineStore } from "./core/ledger.mjs";
import { normalizeMoodleSnapshot } from "./core/normalize.mjs";
import { MoodlePipelineService } from "./core/service.mjs";

function stripAssignmentResources(assignment) {
  return { ...assignment, introattachments: [], attachments: [] };
}

export function restrictSnapshotToDomains(snapshot, enabledDomains) {
  const enabled = new Set(enabledDomains);
  return {
    ...snapshot,
    coursePayloads: (snapshot.coursePayloads || []).map((payload) => {
      let assignments = [];
      if (enabled.has("assignments")) {
        if (Array.isArray(payload.assignments)) {
          assignments = enabled.has("resources")
            ? payload.assignments
            : payload.assignments.map(stripAssignmentResources);
        } else if (payload.assignments?.courses) {
          assignments = {
            ...payload.assignments,
            courses: payload.assignments.courses.map((course) => ({
              ...course,
              assignments: enabled.has("resources")
                ? course.assignments
                : (course.assignments || []).map(stripAssignmentResources)
            }))
          };
        }
      }
      return {
        ...payload,
        contents: enabled.has("resources") ? payload.contents || [] : [],
        assignments,
        forums: enabled.has("announcements") ? payload.forums || [] : [],
        announcements: enabled.has("announcements") ? payload.announcements || [] : []
      };
    })
  };
}

export async function invokeRuntimeCommand(runtime, command, input = {}) {
  switch (command) {
    case "sync":
      return runtime.service.scan(input);
    case "feed":
      return runtime.service.getFeed(input);
    case "review.show":
      return runtime.service.getReviewItem(input);
    case "review.decide":
      return runtime.service.setReviewDecision({
        actions: input.actions || [input]
      });
    case "cache":
      return runtime.service.cacheResources(input);
    case "delivery.prepare":
      return runtime.coordinator.prepare(input);
    case "delivery.execute":
      return runtime.coordinator.deliver(input);
    case "status":
      return runtime.service.getStatus();
    default:
      throw new TypeError(`Unsupported runtime command: ${command}`);
  }
}

export function createStandaloneRuntime(
  config,
  {
    credentialProvider,
    confirmationProvider = null,
    fetchImpl = globalThis.fetch,
    clock = () => Date.now()
  } = {}
) {
  if (!config?.siteUrl) throw new TypeError("Moodle site URL is required");
  if (typeof credentialProvider?.getWebServiceToken !== "function") {
    throw new TypeError("A Moodle credential provider is required");
  }
  const store = new MoodlePipelineStore({
    dbPath: path.join(config.dataDir, "ledger.sqlite"),
    now: clock
  });
  try {
    const client = new MoodleMobileClient({
      siteKey: config.siteUrl,
      credentialProvider,
      fetchImpl
    });
    const icsAdapter = new MoodleIcsAdapter({ credentialProvider, fetchImpl });
    const sourceAdapter = new MoodleMobileSourceAdapter({
      client,
      icsAdapter,
      courseConcurrency: config.courseConcurrency
    });
    const resourceCache = new MoodleResourceCache({
      store,
      client,
      dataDir: config.dataDir,
      maxFileBytes: config.maxFileBytes,
      maxBatchBytes: config.maxBatchBytes,
      now: clock
    });
    const service = new MoodlePipelineService({
      store,
      sourceAdapter,
      normalizer: (snapshot) => normalizeMoodleSnapshot(
        restrictSnapshotToDomains(snapshot, config.enabledDomains)
      ),
      diffEngine: diffMoodleObjects,
      resourceCache,
      scanLockPath: path.join(config.dataDir, "scan.lock"),
      clock
    });
    const coordinator = new MoodleDeliveryCoordinator({
      store,
      adapters: [new LocalArchiveAdapter({ rootDir: config.archiveRoot, cache: resourceCache })],
      confirmationProvider,
      clock,
      writeEnabled: config.writeEnabled
    });
    return {
      config,
      store,
      client,
      resourceCache,
      service,
      coordinator,
      close() {
        store.close();
      }
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
