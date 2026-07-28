import { createHash } from "node:crypto";
import { pool } from "./db";
import type { Channel, ToolTier } from "../tools/types";

/**
 * The universal tool audit (MORT_V2_PLAN I.3, decision V2-5).
 *
 * Every tool invocation on every channel is recorded here by the harness —
 * including the ones that never ran because the policy tiers refused them.
 * That last part is the point: an audit log that only records what succeeded
 * cannot answer "did anything try to reach past its channel today", which is
 * the question the whole tier model exists to make answerable.
 *
 * This is a different artifact from `mort_journal`. That one is the decision
 * journal — a handful of rows a day, rendered as prose in the admin panel,
 * answering "why is this page like this". This is the call log: every
 * kb_search of every turn. See the schema comment on `mort_tool_calls`.
 */

export type ToolOutcome = "ok" | "error" | "refused";

/** Where a call came from. Chat and dream have no source file, so no sourceId. */
export type ToolCallEntry = {
  tool: string;
  tier: ToolTier;
  channel: Channel | "admin";
  /** A user id/email, or the literal 'system'. Never model-supplied. */
  actor: string;
  conversationId?: string | null;
  /** Hashed, not stored — see argsHash. */
  args: unknown;
  outcome: ToolOutcome;
  /** Why it was refused, or what went wrong. Truncated. */
  detail?: string | null;
  latencyMs: number;
};

const DETAIL_LIMIT = 500;

/**
 * A stable fingerprint of a call's arguments.
 *
 * Object key order is normalised so the same call hashes the same however the
 * model happened to serialise it — otherwise "was this the same call as an
 * hour ago" is unanswerable, which is most of what an args hash is for.
 */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex").slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Record one call. Never throws: a turn must not fail because its audit row
 * didn't land, and swallowing here is what lets the harness wrap every tool
 * unconditionally. A write that fails is logged to stderr, where the ops
 * rails already look.
 */
export async function recordToolCall(entry: ToolCallEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO mort_tool_calls (tool, tier, channel, actor, conversation_id, args_hash, outcome, detail, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.tool,
        entry.tier,
        entry.channel,
        entry.actor,
        entry.conversationId ?? null,
        argsHash(entry.args),
        entry.outcome,
        entry.detail ? entry.detail.slice(0, DETAIL_LIMIT) : null,
        Math.max(0, Math.round(entry.latencyMs)),
      ],
    );
  } catch (err) {
    console.error(`[mort] could not journal tool call '${entry.tool}':`, err);
  }
}

export type ToolCallRow = {
  id: number;
  ts: string;
  tool: string;
  tier: string;
  channel: string;
  actor: string;
  conversationId: string | null;
  argsHash: string;
  outcome: ToolOutcome;
  detail: string | null;
  latencyMs: number;
};

/** The audit trail, newest first. `refusedOnly` is the security view of it. */
export async function listToolCalls(
  opts: { limit?: number; refusedOnly?: boolean; channel?: Channel } = {},
): Promise<ToolCallRow[]> {
  const { rows } = await pool.query(
    `SELECT id::int AS id, ts, tool, tier, channel, actor, conversation_id, args_hash, outcome, detail, latency_ms
       FROM mort_tool_calls
      WHERE ($1::boolean IS NOT TRUE OR outcome = 'refused')
        AND ($2::text IS NULL OR channel = $2)
      ORDER BY ts DESC, id DESC
      LIMIT $3`,
    [opts.refusedOnly ?? false, opts.channel ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 500)],
  );
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    tool: r.tool,
    tier: r.tier,
    channel: r.channel,
    actor: r.actor,
    conversationId: r.conversation_id,
    argsHash: r.args_hash,
    outcome: r.outcome as ToolOutcome,
    detail: r.detail,
    latencyMs: r.latency_ms,
  }));
}

export type ToolCallSummary = { calls: number; refused: number; errors: number; p95LatencyMs: number };

/** Today's call volume — the "is the harness actually seeing everything" number. */
export async function toolCallsToday(): Promise<ToolCallSummary> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS calls,
            count(*) FILTER (WHERE outcome = 'refused')::int AS refused,
            count(*) FILTER (WHERE outcome = 'error')::int AS errors,
            COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95
       FROM mort_tool_calls WHERE ts >= CURRENT_DATE`,
  );
  const r = rows[0] ?? {};
  return { calls: r.calls ?? 0, refused: r.refused ?? 0, errors: r.errors ?? 0, p95LatencyMs: r.p95 ?? 0 };
}
