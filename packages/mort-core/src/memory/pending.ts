import { randomUUID } from "node:crypto";
import { pool } from "./db";

/**
 * The confirm-then-live staging table (MORT_V2_PLAN §I.4).
 *
 * A write tool called during a chat turn never writes. It parks its payload
 * here and hands the model a `pendingId` to show the user; the write happens
 * only when a named human confirms, and the executor stamps attribution from
 * THAT human's session. The model can propose anything it likes — it cannot
 * make anything true, and it cannot say who approved it.
 *
 * Pending rows expire (24h by default) so an abandoned conversation can't leave
 * an executable payload lying around indefinitely.
 */

export type PendingTool = "apply_doc_edit" | "create_doc" | "attach_source" | "save_fact" | "log_event";

export type PendingStatus = "pending" | "confirmed" | "cancelled" | "expired";

export type PendingAction = {
  id: string;
  conversationId: string | null;
  userId: string;
  tool: PendingTool;
  payload: Record<string, unknown>;
  preview: string | null;
  status: PendingStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
};

const COLS = `id, conversation_id, user_id, tool, payload, preview, status, created_at, expires_at, decided_at, decided_by`;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function map(r: Record<string, unknown>): PendingAction {
  return {
    id: r.id as string,
    conversationId: (r.conversation_id as string) ?? null,
    userId: r.user_id as string,
    tool: r.tool as PendingTool,
    payload: (r.payload as Record<string, unknown>) ?? {},
    preview: (r.preview as string) ?? null,
    status: r.status as PendingStatus,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    decidedAt: r.decided_at ? iso(r.decided_at) : null,
    decidedBy: (r.decided_by as string) ?? null,
  };
}

/**
 * Per-user cap on pending-action creation (MORT_V2_PLAN §IV). A conversation
 * that runs away — a brain dump split into forty pages, a retry loop — must not
 * be able to flood the queue with executable payloads.
 */
export const PENDING_DAILY_CAP = 30;

export async function countPendingCreatedToday(userId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM mort_pending_actions
      WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

export async function createPendingAction(input: {
  conversationId?: string | null;
  userId: string;
  tool: PendingTool;
  payload: Record<string, unknown>;
  preview?: string | null;
  ttlHours?: number;
}): Promise<PendingAction> {
  const id = randomUUID();
  const ttl = Math.min(Math.max(input.ttlHours ?? 24, 1), 24 * 7);
  const { rows } = await pool.query(
    `INSERT INTO mort_pending_actions (id, conversation_id, user_id, tool, payload, preview, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval)
     RETURNING ${COLS}`,
    [
      id,
      input.conversationId ?? null,
      input.userId,
      input.tool,
      JSON.stringify(input.payload),
      input.preview ?? null,
      String(ttl),
    ],
  );
  return map(rows[0]);
}

export async function getPendingAction(id: string): Promise<PendingAction | null> {
  const { rows } = await pool.query(`SELECT ${COLS} FROM mort_pending_actions WHERE id = $1`, [id]);
  return rows.length ? map(rows[0]) : null;
}

/**
 * Claim a pending action for a decision. Atomic compare-and-set on
 * status='pending' AND not expired, so a double-clicked Confirm executes once.
 * Returns the claimed row, or null when it was already decided or has expired.
 */
export async function claimPendingAction(
  id: string,
  status: Exclude<PendingStatus, "pending">,
  decidedBy: string,
): Promise<PendingAction | null> {
  const { rows } = await pool.query(
    `UPDATE mort_pending_actions
        SET status = $2, decided_at = now(), decided_by = $3
      WHERE id = $1 AND status = 'pending' AND expires_at > now()
      RETURNING ${COLS}`,
    [id, status, decidedBy],
  );
  return rows.length ? map(rows[0]) : null;
}

/** Put a claimed action back to pending — used when its executor threw. */
export async function releasePendingAction(id: string): Promise<void> {
  await pool.query(
    `UPDATE mort_pending_actions SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = $1`,
    [id],
  );
}

export async function listPendingActions(params: {
  userId: string;
  conversationId?: string | null;
  limit?: number;
}): Promise<PendingAction[]> {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM mort_pending_actions
      WHERE user_id = $1
        AND status = 'pending'
        AND expires_at > now()
        AND ($2::uuid IS NULL OR conversation_id = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [params.userId, params.conversationId ?? null, Math.min(Math.max(params.limit ?? 20, 1), 100)],
  );
  return rows.map(map);
}

/** Sweep stale rows. Cheap, idempotent; called before listing/confirming. */
export async function expireStalePendingActions(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE mort_pending_actions SET status = 'expired', decided_at = now()
      WHERE status = 'pending' AND expires_at <= now()`,
  );
  return rowCount ?? 0;
}
