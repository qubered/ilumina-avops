import { env as coreEnv } from "@mort/core/env";
import { getSelfUserId } from "@mort/core/kb/outline";
import { buildWriteDeps } from "@mort/core/kb/write-deps";
import { executeReview } from "@mort/core/kb/execute";
import { getEffectiveMode, getEffectiveThreshold, setMode as coreSetMode } from "@mort/core/memory/config";
import {
  appendJournal,
  getReviewItem,
  insertFact,
  listCurrentFacts as coreListCurrentFacts,
  listLibrary,
  listPendingReviews as coreListPendingReviews,
  recentActivity,
  resolveReview,
  retireFact as coreRetireFact,
} from "@mort/core/memory";
import { listActiveJobs, listDeadJobs, queueStats, reviveJob as coreReviveJob, tokensToday } from "@mort/core/memory/jobs";

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

export async function decideReview(
  id: number,
  decision: "approve" | "reject",
  decidedBy?: string,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const item = await getReviewItem(id);
  if (!item) return { ok: false, status: 404, json: { error: "Not found" } };
  if (item.status !== "pending") {
    return { ok: false, status: 409, json: { error: `already ${item.status}` } };
  }

  if (decision === "reject") {
    await resolveReview(id, "rejected", decidedBy);
    // The bytes stay: rejecting "attach this to THAT page" says nothing about
    // whether the file belongs somewhere else, and Mort re-checks his library
    // whenever a new page appears. They're reclaimed when the source is deleted.
    return { ok: true, status: 200, json: { id, status: "rejected" } };
  }

  // Approve → execute the proposed action, then mark approved. If the executor
  // can't handle it yet (ATTACH/tombstone), leave the item pending and 422.
  try {
    const selfUserId = await getSelfUserId().catch(() => null);
    const result = await executeReview(item, buildWriteDeps(selfUserId));
    await resolveReview(id, "approved", decidedBy);
    await appendJournal({
      sourceId: item.source_id,
      outlineDocumentId: result.docId,
      action: `approved:${item.action}`,
      rationale: `review ${id}`,
    });
    return { ok: true, status: 200, json: { id, status: "approved", ...result } };
  } catch (err) {
    console.error(`[mort-admin] execute ${id} failed:`, err);
    return {
      ok: false,
      status: 422,
      json: { id, status: "pending", error: err instanceof Error ? err.message : "execute failed" },
    };
  }
}

export type MortMode = "off" | "shadow" | "live";
export type MortConfig = { mode: MortMode; threshold: number; envDefault: string };

export async function getMortConfig(): Promise<MortConfig> {
  return {
    mode: await getEffectiveMode(),
    threshold: await getEffectiveThreshold(),
    envDefault: coreEnv.MORT_MODE,
  };
}

export type MortHealth = {
  mode: MortMode;
  queue: { pending: number; running: number; dead: number };
  tokensToday: number;
  dailyTokenCap: number | null;
  capReached: boolean;
  deadJobs: Array<{ id: number; sourceId: string; attempts: number; lastError: string | null }>;
};

/** Ops health: queue depth, dead-letters, today's model spend. Null on failure. */
export async function getMortHealth(): Promise<MortHealth | null> {
  try {
    const [queue, spent, dead] = await Promise.all([queueStats(), tokensToday(), listDeadJobs(10)]);
    const cap = coreEnv.MORT_DAILY_TOKEN_CAP;
    return {
      mode: await getEffectiveMode(),
      queue,
      tokensToday: spent,
      dailyTokenCap: cap || null,
      capReached: cap > 0 && spent >= cap,
      deadJobs: dead,
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

export type MortActivity = {
  journal: MortActivityRow[];
  library: MortLibraryRow[];
  queue: MortActiveJob[];
};

/** What Mort has been doing, what's in flight, and everything he holds. Null on failure. */
export async function getMortActivity(query?: string): Promise<MortActivity | null> {
  try {
    const [journal, library, queue] = await Promise.all([
      recentActivity(50),
      listLibrary(query),
      listActiveJobs(),
    ]);
    return { journal, library, queue };
  } catch (err) {
    console.error("[mort-admin] getMortActivity failed:", err);
    return null;
  }
}

export type MortFact = {
  id: number;
  factKey: string;
  value: string;
  scope: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceTier: string | null;
  approvedBy: string;
  confidence: string | null;
  note: string | null;
};

/** Human-approved current-state facts in force today. Empty on failure. */
export async function listCurrentFacts(query?: string): Promise<MortFact[]> {
  try {
    return await coreListCurrentFacts(query);
  } catch (err) {
    console.error("[mort-admin] listCurrentFacts failed:", err);
    return [];
  }
}

export async function createFact(
  fact: Omit<MortFact, "id" | "effectiveTo"> & { effectiveTo?: string | null },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  try {
    const id = await insertFact(fact);
    await appendJournal({
      action: "fact_approved",
      rationale: `${fact.factKey} = ${fact.value} (by ${fact.approvedBy})`,
    });
    return { ok: true, status: 201, json: { id } };
  } catch (err) {
    return { ok: false, status: 500, json: { error: err instanceof Error ? err.message : "failed" } };
  }
}

export async function retireFact(id: number): Promise<{ ok: boolean }> {
  const ok = await coreRetireFact(id);
  return { ok };
}

export async function setMortMode(mode: MortMode): Promise<{ ok: boolean; status: number; json: unknown }> {
  await coreSetMode(mode);
  console.log(`[mort] mode set to ${mode} via admin`);
  return { ok: true, status: 200, json: { mode } };
}
