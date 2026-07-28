import { env as coreEnv } from "@mort/core/env";
import { decideReviewItem } from "@mort/core/kb/review";
import { changeDigest, type ChangeDigest } from "@mort/core/memory/digest";
import {
  getEffectiveMode,
  getEffectiveThreshold,
  getIngestEngine,
  getMaxSteps,
  setIngestEngine as coreSetIngestEngine,
  setMaxSteps as coreSetMaxSteps,
  setMode as coreSetMode,
  type IngestEngine,
} from "@mort/core/memory/config";
import {
  getChannelBudget,
  getDailyTokenCap,
  setChannelBudget as coreSetChannelBudget,
  spendToday,
  spendTodayByChannel,
} from "@mort/core/memory/spend";
import { listToolCalls, toolCallsToday, type ToolCallRow, type ToolCallSummary } from "@mort/core/memory/tool-journal";
import { CHANNELS, type Channel } from "@mort/core/tools/types";
import {
  appendJournal,
  factHistory as coreFactHistory,
  listCurrentFacts as coreListCurrentFacts,
  listLibrary,
  listPendingReviews as coreListPendingReviews,
  recentActivity,
  retireFact as coreRetireFact,
  saveFactSuperseding,
  setSetting,
  type MortFact as CoreMortFact,
} from "@mort/core/memory";
import { chatWritesEnabled } from "@mort/core/tools/policy";
import { listActiveJobs, listDeadJobs, queueStats, reviveJob as coreReviveJob } from "@mort/core/memory/jobs";
import { listRecentPendingActions, type PendingAction } from "@mort/core/memory/pending";

/**
 * Direct-call replacement for the old mort-review.ts HTTP client — this is
 * the admin UI's one remaining reason to talk to "Mort's brain" now that
 * mort_memory/current_state (agent.ts) and kb_search/event_log already call
 * @mort/core directly. Same aggregate shapes the ingest service's /mort/*
 * routes used to build, so the admin pages/components don't need to change.
 */

export type MortReviewItem = {
  id: number;
  action: string;
  source_id: string | null;
  target_doc_id: string | null;
  payload: { title?: string; collection?: string | null; regionBody?: string } | null;
  rationale: string | null;
  created_at: string;
};

export async function listPendingReviews(): Promise<MortReviewItem[]> {
  return coreListPendingReviews(200);
}

/**
 * The console's door onto a review decision. The decision itself lives in
 * `@mort/core/kb/review` (P8) because there are now two doors onto it — this
 * one and an admin triaging the queue from a conversation — and two copies of
 * a decision is how two slightly different decisions start. All this does is
 * map the outcome onto HTTP.
 */
export async function decideReview(
  id: number,
  decision: "approve" | "reject",
  decidedBy?: string,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const result = await decideReviewItem(id, decision, { channel: "admin", decidedBy });
  if (result.ok) return { ok: true, status: 200, json: result };
  // An executor that couldn't carry the action out leaves the item pending, so
  // 422 (not 500): the request was fine, the proposal isn't executable.
  const status = result.reason === "not_found" ? 404 : result.reason === "already_decided" ? 409 : 422;
  return { ok: false, status, json: { id, error: result.message } };
}

export type MortMode = "off" | "shadow" | "live";
export type MortConfig = {
  mode: MortMode;
  threshold: number;
  envDefault: string;
  chatWrites: boolean;
  engine: IngestEngine;
};

export async function getMortConfig(): Promise<MortConfig> {
  return {
    mode: await getEffectiveMode(),
    threshold: await getEffectiveThreshold(),
    envDefault: coreEnv.MORT_MODE,
    chatWrites: await chatWritesEnabled(),
    engine: await getIngestEngine(),
  };
}

/**
 * The v2/P6 cutover switch: which engine decides what happens to an arriving
 * file. Runtime rather than deploy-time so a rollback is one click — and
 * because the evidence for flipping it (the parity run) is gathered against a
 * deployment's own corpus, not in CI.
 */
export async function setIngestEngine(engine: IngestEngine): Promise<void> {
  await coreSetIngestEngine(engine);
  await appendJournal({
    action: `engine:${engine}`,
    rationale: `ingestion engine switched to ${engine} from the admin console`,
    channel: "admin",
  });
  console.log(`[mort] ingestion engine → ${engine}`);
}

/**
 * The chat-write kill switch (MORT_V2_PLAN §IV). Separate from `mode` on
 * purpose: `mode` governs what the ingest pipeline does with files, this
 * governs whether a conversation can change the wiki at all. Turning it off
 * leaves Q&A working exactly as before.
 */
export async function setChatWrites(enabled: boolean): Promise<void> {
  await setSetting("chat_writes", enabled ? "on" : "off");
  console.log(`[mort] chat writes ${enabled ? "enabled" : "disabled"} via admin`);
}

/** One channel's slice of today's spend, against its soft budget (P4). */
export type MortChannelSpend = {
  channel: Channel;
  tokens: number;
  /** Soft: reported, never enforced. The daily cap is the hard rail. */
  budget: number | null;
  overBudget: boolean;
  /** Steps a turn on this channel may take — mort_settings, per channel. */
  maxSteps: number;
};

export type MortHealth = {
  mode: MortMode;
  queue: { pending: number; running: number; dead: number };
  tokensToday: number;
  dailyTokenCap: number | null;
  capReached: boolean;
  deadJobs: Array<{ id: number; sourceId: string; attempts: number; lastError: string | null }>;
  /** Where today's tokens went — chat included, which v1's cap never saw. */
  channels: MortChannelSpend[];
  /** Volume through the harness today, and how much of it was refused. */
  tools: ToolCallSummary;
};

/**
 * Ops health: queue depth, dead-letters, today's model spend by channel, and
 * what the tool harness saw.
 *
 * The per-channel breakdown is the P4 addition that matters most in practice:
 * the cap is now shared, so "we hit the cap" immediately raises "which channel
 * spent it", and that used to be unanswerable. Null on failure.
 */
export async function getMortHealth(): Promise<MortHealth | null> {
  try {
    const [queue, spent, dead, cap, byChannel, tools] = await Promise.all([
      queueStats(),
      spendToday(),
      listDeadJobs(10),
      getDailyTokenCap(),
      spendTodayByChannel(),
      toolCallsToday(),
    ]);
    const channels = await Promise.all(
      CHANNELS.map(async (channel): Promise<MortChannelSpend> => {
        const tokens = byChannel[channel] ?? 0;
        const budget = await getChannelBudget(channel);
        return { channel, tokens, budget, overBudget: budget != null && tokens >= budget, maxSteps: await getMaxSteps(channel) };
      }),
    );
    return {
      mode: await getEffectiveMode(),
      queue,
      tokensToday: spent,
      dailyTokenCap: cap || null,
      capReached: cap > 0 && spent >= cap,
      deadJobs: dead,
      channels,
      tools,
    };
  } catch (err) {
    console.error("[mort-admin] getMortHealth failed:", err);
    return null;
  }
}

/**
 * Re-queues a dead-lettered job. Note: this no longer "kicks" ingest's local
 * poll loop the way the old HTTP call did (that's a different process now,
 * with no wakeup channel) — the job just waits for ingest's next poll tick
 * (MORT_POLL_MS, default 3s). Bounded delay, not a correctness issue.
 */
export async function reviveJob(id: number): Promise<{ ok: boolean }> {
  const ok = await coreReviveJob(id);
  return { ok };
}

export type MortActivityRow = {
  ts: string;
  sourceId: string | null;
  action: string;
  rationale: string | null;
  confidence: number | null;
  tokens: number | null;
  model: string | null;
  docTitle: string | null;
  outlineDocumentId: string | null;
  actor: string;
  channel: "chat" | "ingest" | "dream" | "admin";
  conversationId: string | null;
};

export type MortLibraryRow = {
  sourceId: string;
  role: string;
  status: string;
  summary: string | null;
  zone: string[];
  system: string[];
  entities: string[];
  updatedAt: string;
  docCount: number;
  hasBytes: boolean;
};

export type MortActiveJob = {
  id: number;
  sourceId: string;
  fileName: string;
  status: string;
  attempts: number;
  runAfter: string;
  force: boolean;
  lastError: string | null;
};

export type MortToolCall = ToolCallRow;

export type MortDigest = ChangeDigest;

export type MortActivity = {
  journal: MortActivityRow[];
  library: MortLibraryRow[];
  queue: MortActiveJob[];
  /**
   * Every tool call the harness saw, newest first (P4, decision V2-5). A
   * different artifact from `journal`: that one says what Mort decided and why,
   * this one says what he reached for — including anything a channel refused.
   */
  toolCalls: MortToolCall[];
  /**
   * The same digest the chat's `change_digest` tool reads (P8). Rendered here
   * so "what's changed this week?" gives the same answer whether it was asked
   * in a conversation or read off this page — one function, two readers, and
   * therefore nothing to disagree about.
   */
  digest: MortDigest | null;
};

/** The window the admin panel summarises, and the tool's own default. */
export const DIGEST_DAYS = 7;

/** What Mort has been doing, what's in flight, and everything he holds. Null on failure. */
export async function getMortActivity(query?: string): Promise<MortActivity | null> {
  try {
    const [journal, library, queue, toolCalls, digest] = await Promise.all([
      recentActivity(50),
      listLibrary(query),
      listActiveJobs(),
      listToolCalls({ limit: 60 }),
      // Best-effort: a digest that won't build is not a reason to lose the
      // queue, the journal and the library, which are what an admin came for.
      changeDigest({ days: DIGEST_DAYS }).catch((err) => {
        console.error("[mort-admin] changeDigest failed:", err);
        return null;
      }),
    ]);
    return { journal, library, queue, toolCalls, digest };
  } catch (err) {
    console.error("[mort-admin] getMortActivity failed:", err);
    return null;
  }
}

/** Core's fact shape, provenance included — the admin UI renders it verbatim. */
export type MortFact = CoreMortFact;

export type MortPendingAction = PendingAction;

/**
 * The confirm-then-live queue, decided or not. Read-only here on purpose:
 * a card is answered by the person Mort raised it with, in their conversation,
 * because that is who the write gets attributed to (V2-1). An admin watching
 * the queue is oversight, not a second approval path.
 */
export async function listMortPendingActions(): Promise<MortPendingAction[]> {
  try {
    return await listRecentPendingActions(50);
  } catch (err) {
    console.error("[mort-admin] listMortPendingActions failed:", err);
    return [];
  }
}

/** Human-approved current-state facts in force today. Empty on failure. */
export async function listCurrentFacts(query?: string): Promise<MortFact[]> {
  try {
    return await coreListCurrentFacts(query);
  } catch (err) {
    console.error("[mort-admin] listCurrentFacts failed:", err);
    return [];
  }
}

/** Every value a key has ever held, newest first — "what was it before?". */
export async function getFactHistory(factKey: string, scope: string | null): Promise<MortFact[]> {
  try {
    return await coreFactHistory(factKey, { scope });
  } catch (err) {
    console.error("[mort-admin] getFactHistory failed:", err);
    return [];
  }
}

/**
 * Declare a fact from the admin panel. Goes through the same superseding path
 * as a fact taught in chat, so a key can only ever have one current answer
 * however it was declared — and the superseded row stays readable as history.
 */
export async function createFact(
  fact: Pick<MortFact, "factKey" | "value" | "scope" | "effectiveFrom" | "note" | "approvedBy"> & {
    sourceTier?: string | null;
    confidence?: string | null;
  },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  try {
    // taughtVia 'admin' is the whole difference between this and the chat
    // path: same write, different door, and the chip says which.
    const { id, superseded } = await saveFactSuperseding({ ...fact, taughtVia: "admin" });
    const supersededId = superseded?.id ?? null;
    await appendJournal({
      action: "fact_approved",
      rationale:
        `${fact.factKey} = ${fact.value} (by ${fact.approvedBy}` +
        (supersededId != null ? `, supersedes #${supersededId}` : "") +
        ")",
      channel: "admin",
      actor: fact.approvedBy,
    });
    return { ok: true, status: 201, json: { id, supersededId } };
  } catch (err) {
    return { ok: false, status: 500, json: { error: err instanceof Error ? err.message : "failed" } };
  }
}

export async function retireFact(id: number, retiredBy: string): Promise<{ ok: boolean }> {
  const ok = await coreRetireFact(id);
  // Retiring is a decision too — without this the fact simply stops appearing
  // and nothing anywhere records who decided it was no longer true.
  if (ok) {
    await appendJournal({
      action: "fact_retired",
      rationale: `fact ${id}`,
      channel: "admin",
      actor: retiredBy,
    });
  }
  return { ok };
}

export async function setMortMode(mode: MortMode): Promise<{ ok: boolean; status: number; json: unknown }> {
  await coreSetMode(mode);
  console.log(`[mort] mode set to ${mode} via admin`);
  return { ok: true, status: 200, json: { mode } };
}

/**
 * The per-channel rails (P4): how many steps a turn may take, and how many
 * tokens a channel is expected to use in a day.
 *
 * Both live in `mort_settings` rather than env so they can be moved during an
 * incident. The budget is soft — it colours the health panel; the daily cap is
 * the thing that actually stops work.
 */
export async function setChannelRails(
  channel: Channel,
  rails: { maxSteps?: number; budget?: number },
): Promise<void> {
  if (rails.maxSteps !== undefined) {
    await coreSetMaxSteps(channel, rails.maxSteps);
    console.log(`[mort] ${channel} max steps set to ${rails.maxSteps} via admin`);
  }
  if (rails.budget !== undefined) {
    await coreSetChannelBudget(channel, rails.budget);
    console.log(`[mort] ${channel} soft budget set to ${rails.budget} via admin`);
  }
}
