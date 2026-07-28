import { randomUUID } from "node:crypto";
import { env } from "../env";
import { pool } from "./db";

/**
 * The confirm-then-live queue (MORT_V2_PLAN I.4).
 *
 * Mort's write tools do not write. They park a payload here alongside the
 * preview the user was shown, and a session-authenticated human either
 * confirms it (the executor runs, attribution stamped from the session) or
 * doesn't (the row expires and nothing happened). This module is the storage
 * half of that contract — deliberately dumb: no policy, no execution, just
 * rows and one CAS transition out of `pending`.
 */

export type PendingTool =
  | "save_fact"
  | "retire_fact"
  | "log_event"
  // write:kb (P3). `apply_doc_edit` is the parked form of a propose_doc_edit —
  // the tool proposes, the card applies.
  | "apply_doc_edit"
  | "create_doc"
  | "attach_source"
  // write:world (P5). Every MCP call parks as this one tool whatever the server
  // called it, so the card, the confirm route and the executor all have a fixed
  // name whose tier they can check.
  | "mcp_call";

export const PENDING_TOOLS: PendingTool[] = [
  "save_fact",
  "retire_fact",
  "log_event",
  "apply_doc_edit",
  "create_doc",
  "attach_source",
  "mcp_call",
];

/** KB cards can be diverted to the admin review queue; memory cards cannot. */
export function isKbWriteTool(tool: PendingTool): boolean {
  return tool === "apply_doc_edit" || tool === "create_doc" || tool === "attach_source";
}

export function isPendingTool(v: unknown): v is PendingTool {
  return typeof v === "string" && (PENDING_TOOLS as string[]).includes(v);
}

export type PendingStatus = "pending" | "confirmed" | "cancelled" | "expired";

export type PendingAction = {
  id: string;
  conversationId: string | null;
  /**
   * The message that prompted this card — the one where the user actually said
   * the thing (P2). It becomes the fact's `message_id`, which is what lets an
   * answer link back to the moment Mort learnt it.
   */
  messageId: string | null;
  userId: string;
  tool: PendingTool;
  payload: Record<string, unknown>;
  preview: string | null;
  status: PendingStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  result: Record<string, unknown> | null;
};

const COLS = `id, conversation_id, message_id, user_id, tool, payload, preview, status, created_at, decided_at, decided_by, result`;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapRow(r: Record<string, unknown>): PendingAction {
  return {
    id: r.id as string,
    conversationId: (r.conversation_id as string) ?? null,
    messageId: (r.message_id as string) ?? null,
    userId: r.user_id as string,
    tool: r.tool as PendingTool,
    payload: (r.payload as Record<string, unknown>) ?? {},
    preview: (r.preview as string) ?? null,
    status: r.status as PendingStatus,
    createdAt: iso(r.created_at),
    decidedAt: r.decided_at ? iso(r.decided_at) : null,
    decidedBy: (r.decided_by as string) ?? null,
    result: (r.result as Record<string, unknown>) ?? null,
  };
}

/**
 * Age out cards nobody answered. Called before every read and every decision
 * rather than on a timer: a stale card must never be confirmable, and lazily
 * sweeping keeps that true without another background job to forget about.
 */
export async function expireStalePendingActions(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE mort_pending_actions
        SET status = 'expired', decided_at = now()
      WHERE status = 'pending'
        AND created_at < now() - make_interval(hours => $1::int)`,
    [env.MORT_PENDING_TTL_HOURS],
  );
  return rowCount ?? 0;
}

/** How many cards this user has raised today — the flood rail (Part IV). */
export async function countPendingActionsToday(userId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM mort_pending_actions
      WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

export async function createPendingAction(input: {
  conversationId: string | null;
  messageId?: string | null;
  userId: string;
  tool: PendingTool;
  payload: Record<string, unknown>;
  preview: string;
}): Promise<PendingAction> {
  const { rows } = await pool.query(
    `INSERT INTO mort_pending_actions (id, conversation_id, message_id, user_id, tool, payload, preview)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLS}`,
    [
      randomUUID(),
      input.conversationId,
      input.messageId ?? null,
      input.userId,
      input.tool,
      JSON.stringify(input.payload),
      input.preview,
    ],
  );
  return mapRow(rows[0]);
}

export async function getPendingAction(id: string): Promise<PendingAction | null> {
  const { rows } = await pool.query(`SELECT ${COLS} FROM mort_pending_actions WHERE id = $1`, [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

/** Open cards, newest first. Scoped by conversation and/or user by the caller. */
export async function listPendingActions(params: {
  conversationId?: string | null;
  userId?: string;
  limit?: number;
}): Promise<PendingAction[]> {
  await expireStalePendingActions();
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM mort_pending_actions
      WHERE status = 'pending'
        AND ($1::uuid IS NULL OR conversation_id = $1)
        AND ($2::text IS NULL OR user_id = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [params.conversationId ?? null, params.userId ?? null, Math.min(Math.max(params.limit ?? 20, 1), 100)],
  );
  return rows.map(mapRow);
}

/** Everything recent, decided or not — the admin panel's view. */
export async function listRecentPendingActions(limit = 50): Promise<PendingAction[]> {
  await expireStalePendingActions();
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM mort_pending_actions ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(mapRow);
}

/** Current status of a set of cards — used to re-render persisted chat cards. */
export async function getPendingStatuses(ids: string[]): Promise<Map<string, PendingStatus>> {
  if (ids.length === 0) return new Map();
  await expireStalePendingActions();
  const { rows } = await pool.query(`SELECT id, status FROM mort_pending_actions WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id as string, r.status as PendingStatus]));
}

/**
 * Amend a card before it is confirmed — the Edit button. Only ever touches a
 * still-pending row, so an edit can't rewrite what was already carried out.
 */
export async function updatePendingPayload(
  id: string,
  payload: Record<string, unknown>,
  preview: string,
): Promise<PendingAction | null> {
  const { rows } = await pool.query(
    `UPDATE mort_pending_actions SET payload = $2, preview = $3
      WHERE id = $1 AND status = 'pending'
      RETURNING ${COLS}`,
    [id, JSON.stringify(payload), preview],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * Take a card out of `pending`, atomically. Returns the claimed row, or null if
 * someone (or the expiry sweep) got there first — the double-confirm guard.
 */
export async function claimPendingAction(
  id: string,
  status: Exclude<PendingStatus, "pending">,
  decidedBy: string,
): Promise<PendingAction | null> {
  await expireStalePendingActions();
  const { rows } = await pool.query(
    `UPDATE mort_pending_actions
        SET status = $2, decided_at = now(), decided_by = $3
      WHERE id = $1 AND status = 'pending'
      RETURNING ${COLS}`,
    [id, status, decidedBy],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Hand a claimed card back to `pending` — the executor failed, so nothing happened. */
export async function releasePendingAction(id: string): Promise<void> {
  await pool.query(
    `UPDATE mort_pending_actions SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = $1`,
    [id],
  );
}

/** Record what the executor actually did, for the audit trail. */
export async function recordPendingResult(id: string, result: Record<string, unknown>): Promise<void> {
  await pool.query(`UPDATE mort_pending_actions SET result = $2 WHERE id = $1`, [id, JSON.stringify(result)]);
}
