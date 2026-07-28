import { pool } from "./db";

/**
 * Runtime settings (`mort_settings`) — the admin-editable overrides for what
 * env vars only set a default for: authoring mode, confidence threshold, the
 * chat-write kill switch, per-channel step caps and budgets.
 *
 * Lifted out of memory/index.ts in P4 for one boring reason: the spend ledger
 * and the tier policy both need to read a setting, and index.ts is where
 * appendJournal lives, which now writes to the ledger. Keeping the two-line
 * accessors in their own module means that arrow only ever points one way.
 * `@mort/core/memory` still re-exports both, so every existing call site is
 * untouched.
 */

export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT value FROM mort_settings WHERE key = $1`, [key]);
  return rows.length ? (rows[0].value as string) : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO mort_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

/** A setting read as a bounded number, falling back when unset or unparseable. */
export async function getNumericSetting(
  key: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): Promise<number> {
  const raw = await getSetting(key);
  const n = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds.max ?? Number.POSITIVE_INFINITY, Math.max(bounds.min ?? Number.NEGATIVE_INFINITY, n));
}
