import { env } from "../env.js";
import { extract } from "../extract.js";
import { getSelfUserId } from "../outline.js";
import { classifyRole } from "./classify.js";
import { getEffectiveMode, getEffectiveThreshold } from "./config.js";
import { buildTurnDeps } from "./deps.js";
import { syncEventSheet } from "./events.js";
import { indexEvents } from "./eventindex.js";
import {
  claimJob,
  completeJob,
  failJob,
  reapStuckJobs,
  tokensToday,
  type MortJob,
} from "./jobs.js";
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
 * Worker for the durable job queue (v1.7 ops rails). Jobs live in Postgres, so a
 * restart or crash loses nothing: orphaned jobs are reaped back to pending,
 * failures retry with backoff and dead-letter after MAX_ATTEMPTS, and a daily
 * token cap stops an autonomous Mort from running up unbounded model spend.
 */

let deps: TurnDeps | null = null;
let selfUserId: string | null = null;
let running = false;
let timer: NodeJS.Timeout | null = null;

export async function initWorker(): Promise<void> {
  selfUserId = await getSelfUserId().catch((e) => {
    console.warn("[mort] could not resolve self user id (curated-doc detection degraded):", e);
    return null;
  });
  deps = buildTurnDeps(selfUserId);

  const reaped = await reapStuckJobs().catch(() => 0);
  if (reaped) console.log(`[mort] returned ${reaped} orphaned job(s) to the queue`);

  if (!timer) {
    timer = setInterval(() => void drain(), env.MORT_POLL_MS);
    timer.unref?.();
  }
  console.log(`[mort] worker ready (mode=${await getEffectiveMode()}, self=${selfUserId ?? "unknown"})`);
  void drain();
}

/** The real Mort deps (also used by the review executor). Builds lazily. */
export async function getDeps(): Promise<TurnDeps> {
  if (!deps) await initWorker();
  return deps!;
}

/** Nudge the worker (called right after an enqueue so we don't wait for the tick). */
export function kickWorker(): void {
  void drain();
}

async function overDailyCap(): Promise<boolean> {
  if (!env.MORT_DAILY_TOKEN_CAP) return false;
  return (await tokensToday()) >= env.MORT_DAILY_TOKEN_CAP;
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!deps) await initWorker();
    if (!deps) return;

    for (;;) {
      const mode = await getEffectiveMode();
      if (mode === "off") return; // jobs stay queued until Mort is switched back on

      if (await overDailyCap()) {
        console.warn(
          `[mort] daily token cap (${env.MORT_DAILY_TOKEN_CAP}) reached — pausing; queued jobs resume tomorrow`,
        );
        return;
      }

      const job = await claimJob();
      if (!job) return;

      try {
        await processJob(job, deps);
        await completeJob(job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const outcome = await failJob(job.id, job.attempts, message);
        console.error(
          `[mort] job ${job.id} (${job.sourceId}) failed on attempt ${job.attempts} → ${outcome}: ${message}`,
        );
      }
    }
  } finally {
    running = false;
  }
}

async function processJob(job: MortJob, d: TurnDeps): Promise<void> {
  // Skip unchanged files (the watcher re-sends whole files; hash short-circuits).
  const known = await getSource(job.sourceId);
  if (known?.checksum === job.contentHash && known.status === "active") {
    console.log(`[mort] ${job.sourceId}: unchanged, skipped`);
    return;
  }

  const mode = await getEffectiveMode();
  if (mode === "off") return;

  const role = classifyRole({ fileName: job.fileName, contentType: job.contentType, folderPath: job.folderPath ?? undefined });

  // Event log (R1): reconcile rows into episodic memory instead of authoring a doc.
  if (role === "event_log") {
    const res = await syncEventSheet(job.sourceId, job.data, {
      getHashes: getEventHashes,
      insertRow: insertEvent,
      deleteHashes: deleteEventsByHash,
    });
    await upsertSource({ sourceId: job.sourceId, checksum: job.contentHash, role, folderOrigin: job.folderPath });
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
    await saveBlob(job.sourceId, { fileName: job.fileName, contentType: job.contentType, data: job.data });
  }

  const extraction = await extract(job.fileName, job.contentType, job.data);
  const outcome = await runMortTurn(
    {
      sourceId: job.sourceId,
      fileName: job.fileName,
      folderPath: job.folderPath ?? undefined,
      contentType: job.contentType,
      extractedMarkdown: extraction.markdown,
    },
    { mode: mode === "live" ? "live" : "shadow", confidenceThreshold: await getEffectiveThreshold() },
    d,
  );

  // Keep the bytes while a file is still waiting for a home: a pending ATTACH
  // proposal, or a HOLD (reference material filed in the library until a page
  // for it appears). Otherwise they're no longer needed.
  const awaitingHome =
    (outcome.decided === "ATTACH" && outcome.executed === "review") || outcome.executed === "held";
  if (mightAttach && !awaitingHome) await deleteBlob(job.sourceId);

  // Record what Mort understood — on every path, including SKIP/HOLD. The library
  // is how he stays aware of files he didn't turn into articles.
  await upsertSource({
    sourceId: job.sourceId,
    checksum: job.contentHash,
    role: outcome.role,
    folderOrigin: job.folderPath,
    summary: outcome.understanding.summary,
    zone: outcome.understanding.zone,
    system: outcome.understanding.system,
    entities: outcome.understanding.entities,
  });
  console.log(
    `[mort] ${job.sourceId}: ${outcome.decided} → ${outcome.executed}${outcome.docId ? ` (${outcome.docId})` : ""} — ${outcome.understanding.summary}`,
  );
}
