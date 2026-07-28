import { createHash } from "node:crypto";
import { pool } from "./db";

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
  const v = h.readBigUInt64BE(0) >> BigInt(1);
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

/**
 * Non-blocking variant: acquire and run only if the key is free right now,
 * otherwise return null immediately. Correct for "reject a concurrent
 * operation" (e.g. a second full sync while one is running) — withKeyLock's
 * blocking pg_advisory_lock would instead queue the caller, which is right
 * for doc/source serialization but wrong here.
 */
export async function tryWithKeyLock<T>(namespace: string, id: string, fn: () => Promise<T>): Promise<T | null> {
  const key = lockKey(namespace, id);
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS ok", [key]);
    if (!rows[0]?.ok) return null;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
    }
  } finally {
    client.release();
  }
}

/** Probe whether a key is currently held, without holding it yourself. */
export async function isKeyLocked(namespace: string, id: string): Promise<boolean> {
  const key = lockKey(namespace, id);
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS ok", [key]);
    const acquired = rows[0]?.ok === true;
    if (acquired) await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
    return !acquired;
  } finally {
    client.release();
  }
}
