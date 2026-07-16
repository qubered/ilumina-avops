import { createHash } from "node:crypto";
import { pool } from "./db.js";

/**
 * Per-key Postgres advisory lock. Serializes Mort's writes to the same target
 * (doc id or source id) across async workers — the watcher's serial ordering
 * doesn't hold once /ingest is queued, so concurrent turns targeting one doc
 * must not interleave read-modify-write. Different keys run in parallel.
 */

/** Map an arbitrary string to a stable signed 64-bit key for pg_advisory_lock. */
function lockKey(namespace: string, id: string): string {
  const h = createHash("sha256").update(`${namespace}:${id}`).digest();
  // Top 63 bits → always-positive bigint that fits Postgres' signed bigint.
  const v = h.readBigUInt64BE(0) >> 1n;
  return v.toString();
}

export async function withKeyLock<T>(namespace: string, id: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(namespace, id);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
    }
  } finally {
    client.release();
  }
}

/** Serialize by target Outline document. */
export const withDocLock = <T>(docId: string, fn: () => Promise<T>) => withKeyLock("doc", docId, fn);
/** Serialize by source file (create-vs-update resolution). */
export const withSourceLock = <T>(sourceId: string, fn: () => Promise<T>) => withKeyLock("source", sourceId, fn);
