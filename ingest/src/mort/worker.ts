import { env } from "../env.js";
import { extract } from "../extract.js";
import { getSelfUserId } from "../outline.js";
import { classifyRole } from "./classify.js";
import { getEffectiveMode, getEffectiveThreshold } from "./config.js";
import { buildTurnDeps } from "./deps.js";
import { syncEventSheet } from "./events.js";
import { indexEvents } from "./eventindex.js";
import {
  deleteBlob,
  deleteEventsByHash,
  getEventHashes,
  getSource,
  insertEvent,
  saveBlob,
  upsertSource,
} from "./memory.js";
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

/** The real Mort deps (for the review executor). Builds lazily if the worker
 *  wasn't started (e.g. approving proposals while MORT_MODE=off). */
export async function getDeps(): Promise<TurnDeps> {
  if (!deps) await initWorker();
  return deps!;
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!deps) await initWorker(); // lazy: mode may have been flipped to live at runtime
    if (!deps) return; // init failed — leave jobs queued for the next drain
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

  const mode = await getEffectiveMode();
  if (mode === "off") {
    console.log(`[mort] ${job.sourceId}: mode flipped to off, skipped`);
    return;
  }

  const role = classifyRole({ fileName: job.fileName, contentType: job.contentType, folderPath: job.folderPath });

  // Event log (R1): reconcile rows into episodic memory instead of authoring a doc.
  if (role === "event_log") {
    const res = await syncEventSheet(job.sourceId, job.buffer, {
      getHashes: getEventHashes,
      insertRow: insertEvent,
      deleteHashes: deleteEventsByHash,
    });
    await upsertSource({ sourceId: job.sourceId, checksum: job.contentHash, role, folderOrigin: job.folderPath ?? null });
    if (!res.guarded) await indexEvents(job.sourceId, res.insertedRows, res.currentHashes);
    console.log(
      `[mort] ${job.sourceId}: event log — +${res.inserted} -${res.deleted} of ${res.total}${res.guarded ? " (guarded: empty sheet, kept existing)" : ""}`,
    );
    return;
  }

  // Reference/media may become an ATTACH → stash the bytes so the turn (live) or
  // a later approval (shadow) can upload them.
  const mightAttach = role === "reference" || role === "media";
  if (mightAttach) {
    await saveBlob(job.sourceId, { fileName: job.fileName, contentType: job.contentType, data: job.buffer });
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
    { mode: mode === "live" ? "live" : "shadow", confidenceThreshold: await getEffectiveThreshold() },
    d,
  );

  // Keep the blob only if it's still needed for a pending ATTACH proposal.
  if (mightAttach && !(outcome.decided === "ATTACH" && outcome.executed === "review")) {
    await deleteBlob(job.sourceId);
  }

  await upsertSource({
    sourceId: job.sourceId,
    checksum: job.contentHash,
    role: outcome.role,
    folderOrigin: job.folderPath ?? null,
  });
  console.log(`[mort] ${job.sourceId}: ${outcome.decided} → ${outcome.executed}${outcome.docId ? ` (${outcome.docId})` : ""}`);
}
