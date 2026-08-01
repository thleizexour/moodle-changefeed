import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  unlink
} from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

async function exists(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function isInsideGitWorktree(filePath) {
  let current = path.dirname(filePath);
  while (true) {
    if (await exists(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function digestFile(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function backupLedger({ sourcePath, destinationPath }) {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(destinationPath)) {
    throw new TypeError("ledger backup paths must be absolute");
  }
  if (sourcePath === destinationPath) {
    throw new TypeError("ledger backup destination must differ from source");
  }
  const source = await exists(sourcePath);
  if (!source?.isFile() || source.isSymbolicLink()) {
    throw new Error("ledger backup source must be a regular file");
  }
  if (await exists(destinationPath)) {
    throw new Error("ledger backup destination already exists");
  }
  if (await isInsideGitWorktree(destinationPath)) {
    throw new Error("ledger backup destination must be outside a Git worktree");
  }

  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let destinationCreated = false;
  try {
    destinationCreated = true;
    await database.backup(destinationPath);
    await chmod(destinationPath, 0o600);
    const handle = await open(destinationPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return await digestFile(destinationPath);
  } catch (error) {
    if (destinationCreated) {
      try {
        await unlink(destinationPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  } finally {
    database.close();
  }
}
