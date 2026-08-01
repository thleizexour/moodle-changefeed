import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("public package rejects private runtime dependencies", async () => {
  let auditPublicImports;
  await assert.doesNotReject(async () => {
    ({ auditPublicImports } = await import("../src/public-boundary.mjs"));
  });

  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const result = await auditPublicImports({ packageRoot });

  assert.deepEqual(result, { findings: [] });
});

test("public package reports a private runtime import without echoing it", async () => {
  const { auditPublicImports } = await import("../src/public-boundary.mjs");
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "changefeed-boundary-"));
  await mkdir(path.join(packageRoot, "src"));
  const privateSpecifier = ["..", "..", "src", "feishu-client.mjs"].join("/");
  await writeFile(
    path.join(packageRoot, "src", "entry.mjs"),
    `import ${JSON.stringify(privateSpecifier)};\n`
  );

  const result = await auditPublicImports({ packageRoot });

  assert.deepEqual(result, {
    findings: [{ file: "src/entry.mjs", rule: "private-import" }]
  });
  assert.doesNotMatch(JSON.stringify(result), /feishu-client/);
});

test("public package reports private service markers without echoing them", async () => {
  const { auditPublicImports } = await import("../src/public-boundary.mjs");
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "changefeed-boundary-"));
  await mkdir(path.join(packageRoot, "src"));
  const markers = ["Key" + "chain", "PersonalStudy" + "Assistant"];
  await writeFile(
    path.join(packageRoot, "src", "services.mjs"),
    `export const services = ${JSON.stringify(markers)};\n`
  );

  const result = await auditPublicImports({ packageRoot });

  assert.deepEqual(result, {
    findings: [{ file: "src/services.mjs", rule: "private-marker" }]
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(markers.join("|")));
});

test("public package reports absolute user paths and symbolic links", async () => {
  const { auditPublicImports } = await import("../src/public-boundary.mjs");
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "changefeed-boundary-"));
  await mkdir(path.join(packageRoot, "src"));
  const userPath = ["", "Users", "student", "private.sqlite"].join("/");
  await writeFile(
    path.join(packageRoot, "src", "path.mjs"),
    `export const value = ${JSON.stringify(userPath)};\n`
  );
  await symlink("path.mjs", path.join(packageRoot, "src", "linked.mjs"));

  const result = await auditPublicImports({ packageRoot });

  assert.deepEqual(result, {
    findings: [
      { file: "src/linked.mjs", rule: "symlink" },
      { file: "src/path.mjs", rule: "absolute-user-path" }
    ]
  });
  assert.doesNotMatch(JSON.stringify(result), /student|private\.sqlite/);
});

test("public package requires an absolute package root", async () => {
  const { auditPublicImports } = await import("../src/public-boundary.mjs");

  await assert.rejects(
    auditPublicImports({ packageRoot: "packages/moodle-changefeed" }),
    /absolute path/
  );
});
