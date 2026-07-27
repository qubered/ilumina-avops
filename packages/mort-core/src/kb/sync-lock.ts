import { isKeyLocked, tryWithKeyLock } from "../memory/lock";

/**
 * Guards the assistant's full KB sync/reset against concurrent runs — was a
 * plain in-memory `let fullSyncRunning = false`, which only protects a single
 * process and does nothing once the assistant scales to multiple replicas.
 * Reuses the same Postgres-advisory-lock pattern ingest's doc/source locks
 * already rely on, just non-blocking (reject immediately, don't queue).
 */
export function withSyncLock<T>(fn: () => Promise<T>): Promise<T | null> {
  return tryWithKeyLock("kb-sync", "full", fn);
}

export function isSyncRunning(): Promise<boolean> {
  return isKeyLocked("kb-sync", "full");
}
