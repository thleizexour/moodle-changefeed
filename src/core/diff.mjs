import { makeMoodleChangeId, sha256Hex } from "./contracts.mjs";

const SIGNAL_ORDER = [
  "due_within_24h",
  "due_within_7d",
  "due_changed_earlier",
  "due_changed_later",
  "required_resource_changed",
  "announcement_new",
  "content_verification_required"
];

function revisionHash(object) {
  if (!object) return null;
  return sha256Hex(`${object.metadataHash || ""}\n${object.contentHash || ""}`);
}

function sameArray(left = [], right = []) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function withSignals(current, previous, changeKind) {
  const signals = new Set(current.prioritySignals || []);
  if (previous?.dueAt && current.dueAt && previous.dueAt !== current.dueAt) {
    if (Date.parse(current.dueAt) < Date.parse(previous.dueAt)) {
      signals.add("due_changed_earlier");
    } else {
      signals.add("due_changed_later");
    }
  }
  if (previous && !sameArray(previous.resourceIds, current.resourceIds)) {
    signals.add("required_resource_changed");
  }
  if (changeKind === "added" && current.type === "announcement") {
    signals.add("announcement_new");
  }
  if (changeKind === "content_changed") {
    signals.add("content_verification_required");
  }
  return {
    ...current,
    prioritySignals: SIGNAL_ORDER.filter((signal) => signals.has(signal))
  };
}

function makeChange({ previous, current, changeKind, createdAt }) {
  const beforeHash = revisionHash(previous);
  const afterHash = revisionHash(current);
  const payload = withSignals(current || previous, previous, changeKind);
  return {
    changeId: makeMoodleChangeId({
      objectId: payload.objectId,
      beforeHash,
      afterHash,
      changeKind
    }),
    objectId: payload.objectId,
    changeKind,
    beforeHash,
    afterHash,
    payload,
    createdAt
  };
}

export function diffMoodleObjects(
  previousObjects,
  currentObjects,
  { baseline = false, complete = false, createdAt } = {}
) {
  if (!Array.isArray(previousObjects) || !Array.isArray(currentObjects)) {
    throw new TypeError("Moodle diff inputs must be arrays");
  }
  if (baseline) return [];
  const previous = new Map(
    previousObjects.map((object) => [object.objectId, object])
  );
  const current = new Map(currentObjects.map((object) => [object.objectId, object]));
  const changes = [];

  for (const objectId of [...current.keys()].sort()) {
    const before = previous.get(objectId);
    const after = current.get(objectId);
    let changeKind;
    if (after.accessLost) {
      changeKind = "access_lost";
    } else if (!before) {
      changeKind = "added";
    } else if (
      before.contentHash &&
      after.contentHash &&
      before.contentHash !== after.contentHash
    ) {
      changeKind = "content_changed";
    } else if (before.metadataHash !== after.metadataHash) {
      changeKind = "metadata_changed";
    } else {
      changeKind = "unchanged";
    }
    changes.push(makeChange({ previous: before, current: after, changeKind, createdAt }));
  }

  if (complete) {
    for (const objectId of [...previous.keys()].sort()) {
      if (current.has(objectId)) continue;
      changes.push(
        makeChange({
          previous: previous.get(objectId),
          current: null,
          changeKind: "possibly_missing",
          createdAt
        })
      );
    }
  }

  return changes.sort((left, right) => left.objectId.localeCompare(right.objectId));
}
