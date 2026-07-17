import { pool } from "./db.js";
import { MAX_ATTEMPTS, backoffMinutes } from "./retry.js";

export { MAX_ATTEMPTS, backoffMinutes };

/**
 * Durable job queue (v1.7 ops rails). Mort runs autonomously in live mode, so a
 * turn must not depend on the process staying up: jobs live in Postgres with
 * their bytes, are claimed atomically, retried with backoff, and dead-lettered
 * after MAX_ATTEMPTS instead of vanishing.
 */

/** A job claimed but not finished within this window is assumed orphaned. */
const STUCK_MINUTES = 15;

export type MortJob = {
  id: number;
  sourceId: string;
  fileName: string;
  contentType: string;
  folderPath: string | null;
  contentHash: string;
  data: Buffer;
  attempts: number;
  /** Re-check even if the content is unchanged (a related page just appeared). */
  force: boolean;
};

/** Enqueue a turn. Idempotent: one live job per (source, content version). */
export async function enqueueJob(job: Omit<MortJob, "id" | "attempts" | "force"> & { force?: boolean }): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO mort_jobs (source_id, file_name, content_type, folder_path, content_hash, data, force)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [job.sourceId, job.fileName, job.contentType, job.folderPath, job.contentHash, job.data, job.force ?? false],
  );
  return rows.length > 0;
}

/**
 * Atomically claim the next runnable job. SKIP LOCKED keeps this correct if more
 * than one worker ever runs.
 */
export async function claimJob(): Promise<MortJob | null> {
  const { rows } = await pool.query(
    `UPDATE mort_jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM mort_jobs
         WHERE status = 'pending' AND run_after <= now()
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id::int AS id, source_id, file_name, content_type, folder_path, content_hash, data, attempts, force`,
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    sourceId: r.source_id,
    fileName: r.file_name,
    contentType: r.content_type,
    folderPath: r.folder_path,
    contentHash: r.content_hash,
    data: r.data as Buffer,
    attempts: r.attempts,
    force: r.force === true,
  };
}

/** Done → drop the row (the journal is the durable record; bytes are large). */
export async function completeJob(id: number): Promise<void> {
  await pool.query(`DELETE FROM mort_jobs WHERE id = $1`, [id]);
}

/** Failed → retry with backoff, or dead-letter once out of attempts. */
export async function failJob(id: number, attempts: number, error: string): Promise<"retry" | "dead"> {
  if (attempts >= MAX_ATTEMPTS) {
    await pool.query(`UPDATE mort_jobs SET status = 'dead', last_error = $2, updated_at = now() WHERE id = $1`, [
      id,
      error.slice(0, 2000),
    ]);
    return "dead";
  }
  await pool.query(
    `UPDATE mort_jobs
        SET status = 'pending', last_error = $2, run_after = now() + ($3 || ' minutes')::interval, updated_at = now()
      WHERE id = $1`,
    [id, error.slice(0, 2000), String(backoffMinutes(attempts))],
  );
  return "retry";
}

/** Return jobs orphaned by a crash to the queue. */
export async function reapStuckJobs(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE mort_jobs SET status = 'pending', updated_at = now()
      WHERE status = 'running' AND updated_at < now() - ($1 || ' minutes')::interval`,
    [String(STUCK_MINUTES)],
  );
  return rowCount ?? 0;
}

/** Re-queue a dead-lettered job (admin retry). */
export async function reviveJob(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE mort_jobs SET status = 'pending', attempts = 0, run_after = now(), last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'dead'`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export type QueueStats = { pending: number; running: number; dead: number };

export async function queueStats(): Promise<QueueStats> {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM mort_jobs WHERE status IN ('pending','running','dead') GROUP BY status`,
  );
  const stats: QueueStats = { pending: 0, running: 0, dead: 0 };
  for (const r of rows) stats[r.status as keyof QueueStats] = r.n as number;
  return stats;
}

export type DeadJob = { id: number; sourceId: string; attempts: number; lastError: string | null };

export async function listDeadJobs(limit = 20): Promise<DeadJob[]> {
  const { rows } = await pool.query(
    `SELECT id::int AS id, source_id, attempts, last_error FROM mort_jobs
      WHERE status = 'dead' ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, sourceId: r.source_id, attempts: r.attempts, lastError: r.last_error }));
}

/** Tokens Mort has spent on model calls today (drives the daily cap). */
export async function tokensToday(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(tokens), 0)::int AS n FROM mort_journal WHERE ts >= CURRENT_DATE`,
  );
  return rows[0]?.n ?? 0;
}
