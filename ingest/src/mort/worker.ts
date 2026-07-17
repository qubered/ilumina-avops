import { env } from "../env.js";
import { extract } from "../extract.js";
import { getSelfUserId } from "../outline.js";
import { classifyRole } from "./classify.js";
import { getEffectiveMode, getEffectiveThreshold } from "./config.js";
import { buildTurnDeps } from "./deps.js";
import { dream, dreamDedupeKey, validateProposals } from "./dream.js";
import { syncEventSheet } from "./events.js";
import { indexEvents } from "./eventindex.js";
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  reapStuckJobs,
  tokensToday,
  type MortJob,
} from "./jobs.js";
import {
  appendJournal,
  deleteEventsByHash,
  docDigest,
  enqueueReview,
  findMortIdByOutlineId,
  getBlob,
  getEventHashes,
  getSource,
  insertEvent,
  libraryDigest,
  listAttachableRelatives,
  saveBlob,
  upsertSource,
} from "./memory.js";
import { runMortTurn, type TurnDeps, type TurnOutcome } from "./turn.js";

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
let dreamTimer: NodeJS.Timeout | null = null;

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
  if (!dreamTimer && env.MORT_DREAM_INTERVAL_HOURS > 0) {
    // Deliberately not fired on boot: a restart shouldn't cost a dream, and the
    // corpus has not changed since the last one.
    dreamTimer = setInterval(() => void runDream(), env.MORT_DREAM_INTERVAL_HOURS * 3_600_000);
    dreamTimer.unref?.();
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

/**
 * Step back and look at the whole corpus (R7). Proposals only — see dream.ts for
 * why this may never write. Exported so the admin route can trigger one on
 * demand rather than waiting for the interval.
 */
export async function runDream(): Promise<{ raised: number; skipped: number } | null> {
  const mode = await getEffectiveMode();
  if (mode === "off") return null;
  if (await overDailyCap()) {
    console.warn("[mort] daily token cap reached — skipping the dream");
    return null;
  }

  const [library, docs] = await Promise.all([libraryDigest(), docDigest()]);
  if (!library.length) return { raised: 0, skipped: 0 };

  const { proposals, tokens } = await dream({ library, docs });
  const valid = validateProposals(proposals, { library, docs });

  let raised = 0;
  for (const p of valid) {
    // Idempotent on the dedupe key: a nightly dream that notices the same thing
    // again is silent, so a proposal a human already dismissed stays dismissed.
    const isNew = await enqueueReview({
      action: `DREAM:${p.kind}`,
      sourceId: p.sourceIds[0] ?? null,
      mortId: p.docIds[0] ?? null,
      rationale: p.rationale,
      payload: { title: p.title, sourceIds: p.sourceIds, docIds: p.docIds, confidence: p.confidence },
      dedupeKey: dreamDedupeKey(p),
    });
    if (isNew) raised++;
  }

  await appendJournal({
    action: "dream",
    rationale: `looked at ${library.length} file(s) and ${docs.length} page(s) — raised ${raised} new of ${valid.length}`,
    tokens,
    model: env.INGEST_AI_PROVIDER,
  });
  console.log(
    `[mort] dreamt over ${library.length} file(s) and ${docs.length} page(s) — ${raised} new proposal(s), ${valid.length - raised} already known`,
  );
  return { raised, skipped: valid.length - raised };
}

async function processJob(job: MortJob, d: TurnDeps): Promise<void> {
  // Skip unchanged files (the watcher re-sends whole files; hash short-circuits).
  // `force` overrides it: the content is the same, but a page this file might
  // belong on has just appeared, so the decision may differ now.
  const known = await getSource(job.sourceId);
  if (!job.force && known?.checksum === job.contentHash && known.status === "active") {
    console.log(`[mort] ${job.sourceId}: unchanged, skipped`);
    return;
  }

  const mode = await getEffectiveMode();
  if (mode === "off") return;

  // Name-based pre-check: the event-log designation is a naming convention, so it
  // needs no extraction (and this avoids parsing a big sheet we're not authoring).
  const preRole = classifyRole({
    fileName: job.fileName,
    contentType: job.contentType,
    folderPath: job.folderPath ?? undefined,
  });

  // Event log (R1): reconcile rows into episodic memory instead of authoring a doc.
  if (preRole === "event_log") {
    const role = preRole;
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

  const extraction = await extract(job.fileName, job.contentType, job.data);

  // Now classify with the CONTENT in hand. Filename alone is not enough: an
  // extensionless SOP arrives as octet-stream and would be filed as an artifact
  // even though it's a document full of prose.
  const role = classifyRole({
    fileName: job.fileName,
    contentType: job.contentType,
    folderPath: job.folderPath ?? undefined,
    extraction: { kind: extraction.kind, text: extraction.markdown },
  });

  // Reference/media go in the library as bytes, and stay there for as long as
  // the source is active. Not just to serve a pending proposal: the same file
  // may belong on a page that doesn't exist yet, and on more than one page once
  // they do. Reclaimed only when the source is deleted (removeSource).
  if (role === "reference" || role === "media") {
    await saveBlob(job.sourceId, { fileName: job.fileName, contentType: job.contentType, data: job.data });
  }
  const outcome = await runMortTurn(
    {
      sourceId: job.sourceId,
      fileName: job.fileName,
      folderPath: job.folderPath ?? undefined,
      contentType: job.contentType,
      extractedMarkdown: extraction.markdown,
      extractionKind: extraction.kind,
    },
    { mode: mode === "live" ? "live" : "shadow", confidenceThreshold: await getEffectiveThreshold() },
    d,
  );

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

  // A page just changed. That changes what its siblings should do — an artifact
  // with nowhere to go now has somewhere, and one already filed elsewhere may
  // belong here too. Re-check them rather than leaving them parked forever.
  //
  // The `!job.force` is what makes this terminate: a re-check job may not spawn
  // re-checks of its own, so a write can cascade exactly one level and no
  // further. Without it, A attaches → re-check B → B attaches → re-check A …
  const wrote = outcome.executed === "created" || outcome.executed === "updated" || outcome.executed === "attached";
  if (wrote && !job.force) await recheckRelatives(job, outcome);
}

async function recheckRelatives(job: MortJob, outcome: TurnOutcome): Promise<void> {
  try {
    const relatives = await listAttachableRelatives({
      excludeSourceId: job.sourceId,
      excludeMortId: outcome.docId ? await findMortIdByOutlineId(outcome.docId) : null,
      folderOrigin: job.folderPath,
      system: outcome.understanding.system,
      entities: outcome.understanding.entities,
    });
    if (!relatives.length) return;

    let queued = 0;
    for (const rel of relatives) {
      // No checksum means this source was never fully ingested. Don't invent one
      // to re-queue it: the turn writes job.contentHash back to the library, so a
      // placeholder would overwrite the real hash and permanently break the
      // unchanged-file check for that source.
      if (!rel.checksum) continue;
      const blob = await getBlob(rel.sourceId);
      if (!blob) continue; // no bytes parked → nothing to attach
      const ok = await enqueueJob({
        sourceId: rel.sourceId,
        fileName: blob.fileName,
        contentType: blob.contentType,
        folderPath: rel.folderOrigin,
        contentHash: rel.checksum,
        data: blob.data,
        force: true, // same bytes, new context — don't let the unchanged check skip it
      });
      if (ok) queued++;
    }
    if (queued) {
      console.log(
        `[mort] ${job.sourceId} ${outcome.executed} a page — re-checking ${queued} library file(s) that may belong on it`,
      );
    }
  } catch (err) {
    // Never fail a completed turn because the follow-up didn't queue.
    console.warn(`[mort] could not re-check library files after ${job.sourceId}:`, err);
  }
}
