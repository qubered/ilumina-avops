import { env } from "../env.js";
import { extract } from "../extract.js";
import { getSelfUserId } from "../outline.js";
import { buildTurnDeps } from "./deps.js";
import { getSource, upsertSource } from "./memory.js";
import { runMortTurn, type TurnDeps } from "./turn.js";

/**
 * In-process job queue for Mort turns (MORT_PLAN §v1.1 async). /ingest enqueues
 * and returns 202; this drains sequentially so per-doc writes never interleave.
 *
 * v1 is intentionally simple (in-memory, single worker). Durable queue, retries,
 * DLQ, cost caps and alerting are the v1.7 ops-rails hardening (P2). A crash
 * loses in-flight jobs; the watcher re-sends on the next scan (content hashes
 * make that safe), so nothing is permanently dropped.
 */

export type TurnJob = {
  sourceId: string;
  fileName: string;
  contentType: string;
  folderPath?: string;
  contentHash: string;
  buffer: Buffer;
};

const queue: TurnJob[] = [];
let running = false;
let deps: TurnDeps | null = null;
let selfUserId: string | null = null;

export async function initWorker(): Promise<void> {
  selfUserId = await getSelfUserId().catch((e) => {
    console.warn("[mort] could not resolve self user id (curated-doc detection degraded):", e);
    return null;
  });
  deps = buildTurnDeps(selfUserId);
  console.log(`[mort] worker ready (mode=${env.MORT_MODE}, self=${selfUserId ?? "unknown"})`);
}

export function enqueueTurn(job: TurnJob): void {
  queue.push(job);
  void drain();
}

async function drain(): Promise<void> {
  if (running || !deps) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        await processJob(job, deps);
      } catch (err) {
        // Poison-file isolation: one bad file must not stall the queue.
        console.error(`[mort] turn failed for ${job.sourceId}:`, err);
      }
    }
  } finally {
    running = false;
  }
}

async function processJob(job: TurnJob, d: TurnDeps): Promise<void> {
  // Skip unchanged files (the watcher re-sends whole files; hash short-circuits).
  const known = await getSource(job.sourceId);
  if (known?.checksum === job.contentHash && known.status === "active") {
    console.log(`[mort] ${job.sourceId}: unchanged, skipped`);
    return;
  }

  const extraction = await extract(job.fileName, job.contentType, job.buffer);
  const outcome = await runMortTurn(
    {
      sourceId: job.sourceId,
      fileName: job.fileName,
      folderPath: job.folderPath,
      contentType: job.contentType,
      extractedMarkdown: extraction.markdown,
    },
    {
      mode: env.MORT_MODE === "live" ? "live" : "shadow",
      confidenceThreshold: env.MORT_CONFIDENCE_THRESHOLD,
    },
    d,
  );

  await upsertSource({
    sourceId: job.sourceId,
    checksum: job.contentHash,
    role: outcome.role,
    folderOrigin: job.folderPath ?? null,
  });
  console.log(`[mort] ${job.sourceId}: ${outcome.decided} → ${outcome.executed}${outcome.docId ? ` (${outcome.docId})` : ""}`);
}
