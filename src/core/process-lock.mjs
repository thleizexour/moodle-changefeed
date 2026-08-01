import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_RETRY_MS = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 120_000;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeIfStale(lockPath, staleMs, now) {
  try {
    const metadata = await stat(lockPath);
    if (now() - metadata.mtimeMs <= staleMs) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

/**
 * Uses atomic directory creation as a cross-process mutex.
 * The target must be a narrow, dedicated lock path.
 */
export async function withProcessLock(
  lockPath,
  operation,
  {
    retryMs = DEFAULT_RETRY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleMs = DEFAULT_STALE_MS,
    label = "跨进程",
    now = () => Date.now()
  } = {}
) {
  if (!path.isAbsolute(lockPath)) {
    throw new Error("跨进程锁必须使用绝对路径。");
  }
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = now() + timeoutMs;

  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await removeIfStale(lockPath, staleMs, now);
      if (now() >= deadline) {
        throw new Error(`等待${label}锁超时，请稍后重试。`);
      }
      await wait(retryMs);
    }
  }

  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
