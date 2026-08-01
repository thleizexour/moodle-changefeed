import {
  canonicalJson,
  sha256Hex
} from "moodle-changefeed/contracts";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class DryRunManifestAdapter {
  id = "dry_run_manifest";

  fingerprint() {
    return "dry-run-manifest:v1";
  }

  plan({ items }) {
    return items.map((item) => {
      const evidence = {
        itemId: item.id,
        expectedReviewVersion: item.version,
        expectedAfterHash: item.afterHash ?? null
      };
      return {
        id: `moodle-delivery-op:v1:${sha256Hex(canonicalJson(evidence))}`,
        itemId: item.id,
        resourceId: null,
        expectedReviewVersion: item.version,
        expectedAfterHash: item.afterHash ?? null,
        contentHash: sha256Hex(canonicalJson({ title: item.title, course: item.course })),
        logicalArchiveSegments: ["Moodle", item.course?.term || "Unsorted", item.title],
        targetType: "task"
      };
    });
  }

  async execute(operation) {
    return {
      status: "delivered",
      externalRef: `dry-run-ref:v1:${sha256Hex(operation.id).slice(0, 24)}`
    };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const adapter = new DryRunManifestAdapter();
  process.stdout.write(`${JSON.stringify({ id: adapter.id, fingerprint: adapter.fingerprint() })}\n`);
}
