import { env } from "../env";
import { pool } from "./db";
import { getNumericSetting, setSetting } from "./settings";
import type { Channel } from "../tools/types";

/**
 * The unified spend rail (MORT_V2_PLAN Part IV, v2 P4).
 *
 * v1's daily token cap was computed by summing `mort_journal.tokens`, and only
 * the ingest worker and the dream ever wrote that column. A chat turn
 * therefore cost nothing as far as the rail was concerned — fine while chat
 * was read-only and cheap, wrong the moment chat could search, read documents
 * and write the wiki. One ledger, every channel, one cap.
 *
 * The cap is a HARD stop for the autonomous channels (ingest, dream): they
 * pause and resume tomorrow. For chat it is deliberately advisory — see
 * `checkChannel`. Cutting a crew member off mid-bump-in because the nightly
 * dream was expensive is a worse failure than the bill.
 */

export type SpendEntry = {
  channel: Channel | "admin";
  actor?: string | null;
  conversationId?: string | null;
  model?: string | null;
  tokens: number;
  /** Set only by appendJournal, so a journal row contributes exactly once. */
  journalId?: number | null;
};

/** Add to the ledger. Never throws — a lost meter reading beats a lost turn. */
export async function recordSpend(entry: SpendEntry): Promise<void> {
  if (!Number.isFinite(entry.tokens) || entry.tokens <= 0) return;
  try {
    await pool.query(
      `INSERT INTO mort_spend (channel, actor, conversation_id, model, tokens, journal_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (journal_id) DO NOTHING`,
      [
        entry.channel,
        entry.actor ?? "system",
        entry.conversationId ?? null,
        entry.model ?? null,
        Math.round(entry.tokens),
        entry.journalId ?? null,
      ],
    );
  } catch (err) {
    console.error("[mort] could not record spend:", err);
  }
}

/** Every channel's model spend so far today. */
export async function spendToday(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(tokens), 0)::int AS n FROM mort_spend WHERE ts >= CURRENT_DATE`,
  );
  return rows[0]?.n ?? 0;
}

export type ChannelSpend = Record<string, number>;

export async function spendTodayByChannel(): Promise<ChannelSpend> {
  const { rows } = await pool.query(
    `SELECT channel, COALESCE(SUM(tokens), 0)::int AS n FROM mort_spend
      WHERE ts >= CURRENT_DATE GROUP BY channel`,
  );
  const out: ChannelSpend = {};
  for (const r of rows) out[r.channel as string] = r.n as number;
  return out;
}

/**
 * The hard daily cap. `mort_settings.daily_token_cap` overrides the env
 * default so an admin can raise it mid-incident without a redeploy; 0 (either
 * place) means uncapped, which is the shipped default.
 */
export async function getDailyTokenCap(): Promise<number> {
  return getNumericSetting("daily_token_cap", env.MORT_DAILY_TOKEN_CAP, { min: 0 });
}

/**
 * A channel's soft budget, or null for none. Soft = reported in health, never
 * enforced: these exist to answer "where did today's tokens go" and to warn
 * before the hard cap arrives, and a per-channel hard stop would just be the
 * daily cap with more ways to be surprised by it.
 */
export async function getChannelBudget(channel: Channel): Promise<number | null> {
  const n = await getNumericSetting(`budget_${channel}`, 0, { min: 0 });
  return n > 0 ? n : null;
}

export async function setChannelBudget(channel: Channel, tokens: number): Promise<void> {
  await setSetting(`budget_${channel}`, String(Math.max(0, Math.round(tokens))));
}

export type SpendStatus = {
  spentToday: number;
  cap: number | null;
  capReached: boolean;
  /** This channel's own spend and its soft budget, if one is configured. */
  channel: { name: Channel; spent: number; budget: number | null; overBudget: boolean };
};

/**
 * The rail for one turn: ask before spending, report after.
 *
 * `blocking` is the difference between the channels. An autonomous channel
 * stops at the cap; a person waiting on an answer does not, because the
 * failure mode of a wrong answer here is someone standing under a truss with
 * no information.
 */
export type SpendRail = {
  channel: Channel;
  /** True when the turn should not start. Always false on a non-blocking channel. */
  exceeded: () => Promise<boolean>;
  status: () => Promise<SpendStatus>;
  record: (tokens: number, opts?: { model?: string | null }) => Promise<void>;
};

/** Which channels a cap actually stops. Chat is measured, never blocked. */
const BLOCKING: Record<Channel, boolean> = { chat: false, ingest: true, dream: true };

export function spendRail(ctx: {
  channel: Channel;
  actor?: string | null;
  conversationId?: string | null;
}): SpendRail {
  const status = async (): Promise<SpendStatus> => {
    const [spent, cap, byChannel, budget] = await Promise.all([
      spendToday(),
      getDailyTokenCap(),
      spendTodayByChannel(),
      getChannelBudget(ctx.channel),
    ]);
    const mine = byChannel[ctx.channel] ?? 0;
    return {
      spentToday: spent,
      cap: cap > 0 ? cap : null,
      capReached: cap > 0 && spent >= cap,
      channel: {
        name: ctx.channel,
        spent: mine,
        budget,
        overBudget: budget != null && mine >= budget,
      },
    };
  };

  return {
    channel: ctx.channel,
    status,
    exceeded: async () => {
      if (!BLOCKING[ctx.channel]) return false;
      return (await status()).capReached;
    },
    record: async (tokens, opts) => {
      await recordSpend({
        channel: ctx.channel,
        actor: ctx.actor ?? "system",
        conversationId: ctx.conversationId ?? null,
        model: opts?.model ?? null,
        tokens,
      });
    },
  };
}
