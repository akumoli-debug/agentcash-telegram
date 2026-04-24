import { defaultLockManager } from "./lockManager.js";

const DEFAULT_USER_LOCK_TTL_MS = 120_000;

export async function withUserLock<T>(userHash: string, fn: () => Promise<T>): Promise<T> {
  return defaultLockManager.withLock(userHash, DEFAULT_USER_LOCK_TTL_MS, fn);
}
