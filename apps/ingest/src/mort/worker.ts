import { env } from "../env.js";
import { extract } from "../extract.js";
import { getSelfUserId } from "@mort/core/kb/outline";
import { classifyRole } from "./classify.js";
import { getEffectiveMode, getEffectiveThreshold, getIngestEngine } from "@mort/core/memory/config";
import { runDreamTurn, runReflectionTurn } from "@mort/core/agent/run-turn";
import { listLessons } from "@mort/core/memory/lessons";
import { collectReflectionSignals, worthReflectingOn } from "@mort/core/memory/signals";
import { runMortAgentTurn } from "./agent-turn.js";
import { buildTurnDeps } from "./deps.js";
import { syncEventSheet } from "./events.js";
import { indexEvents } from "./eventindex.js";
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  reapStuckJobs,
  type MortJob,
} from "@mort/core/memory/jobs";
import { spendRail } from "@mort/core/memory/spend";
import {
  appendJournal,
  deleteEventsByHash,
  docDigest,
  findMortIdByOutlineId,
  getBlob,
  getEventHashes,
  getSource,
  insertEvent,
  libraryDigest,
  listAttachableRelatives,
  listUnfiledArtifacts,
  saveBlob,
  upsertSource,
} from "@mort/core/memory";
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
  console.log(
    `[mort] worker ready (mode=${await getEffectiveMode()}, engine=${await getIngestEngine()}, self=${selfUserId ?? "unknown"})`,
  );
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

/**
 * The shared spend rail (v2 P4). It used to be this file's own sum over
 * `mort_journal.tokens`, which only ever counted what ingestion and the dream
 * spent — so a busy day of chat cost nothing as far as the cap was concerned.
 * One ledger now, every channel, and the cap itself is admin-settable at
 * runtime rather than env-only. See @mort/core/memory/spend.
 */
const ingestSpend = spendRail({ channel: "ingest" });
const dreamSpend = spendRail({ channel: "dream" });

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!deps) await initWorker();
    if (!deps) return;

    for (;;) {
      const mode = await getEffectiveMode();
      if (mode === "off") return; // jobs stay queued until Mort is switched back on

      if (await ingestSpend.exceeded()) {
        const { spentToday, cap } = await ingestSpend.status();
        console.warn(
          `[mort] daily token cap (${spentToday}/${cap}) reached across all channels — pausing; queued jobs resume tomorrow`,
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
 * Re-check every artifact Mort is holding that still feeds no page.
 *
 * A held file is normally re-checked when a page it might belong on is written.
 * That trigger is fine while files are arriving, and useless the moment they
 * stop: once a bulk ingest finishes, nothing writes a page, so nothing re-checks
 * anything, and every artifact that arrived before its page stays held forever.
 * That's the state "he made the pages but attached nothing to them" describes.
 *
 * Each file gets a normal turn — same gating, same confidence threshold — so in
 * shadow this proposes and in live it attaches.
 */
async function recheckUnfiled(): Promise<number> {
  const unfiled = await listUnfiledArtifacts();
  let queued = 0;
  for (const f of unfiled) {
    const blob = await getBlob(f.sourceId);
    if (!blob || !f.checksum) continue;
    const ok = await enqueueJob({
      sourceId: f.sourceId,
      fileName: blob.fileName,
      contentType: blob.contentType,
      folderPath: f.folderOrigin,
      contentHash: f.checksum,
      data: blob.data,
      force: true, // same bytes; the KB around them is what changed
    });
    if (ok) queued++;
  }
  if (queued) {
    console.log(`[mort] dream — re-checking ${queued} held file(s) against the KB as it now stands`);
    kickWorker();
  }
  return queued;
}

/**
 * Step back and look at the whole corpus (R7), then at his own record (v2/P7).
 * Three halves, which is one more than a half allows, but they are:
 *
 *  1. Re-check what's still homeless — the cheap, mechanical one (no model).
 *  2. Ask what only the whole corpus can answer — what's missing, what
 *     contradicts, what should merge. Proposals only; see agent/dream-tools.ts.
 *  3. Reflect: where was I wrong last week, and what pattern explains it.
 *     Lessons only; see agent/reflect-tools.ts.
 *
 * Exported so the admin route can trigger one on demand rather than waiting for
 * the interval.
 */
export async function runDream(): Promise<{
  raised: number;
  skipped: number;
  rechecked: number;
  learned: number;
} | null> {
  const mode = await getEffectiveMode();
  if (mode === "off") return null;
  if (await dreamSpend.exceeded()) {
    console.warn("[mort] daily token cap reached — skipping the dream");
    return null;
  }

  // First, and regardless of what the model makes of the corpus: anything held
  // with nowhere to go gets another look. This costs nothing and is the half
  // that actually moves files onto pages.
  const rechecked = await recheckUnfiled();

  const [library, docs] = await Promise.all([libraryDigest(), docDigest()]);
  if (!library.length) return { raised: 0, skipped: 0, rechecked, learned: 0 };

  // A dream is a turn now (v2/P6): same loop, same harness, same journal — it
  // just gets the read tools and the review queue instead of the pen, so it can
  // actually READ the two pages before claiming they contradict each other.
  // Proposals stay idempotent on their dedupe key, so a nightly dream re-raises
  // nothing a human already dismissed.
  const { raised, duplicates, tokens, steps } = await runDreamTurn({ library, docs });

  await appendJournal({
    action: "dream",
    rationale: `looked at ${library.length} file(s) and ${docs.length} page(s) over ${steps} step(s) — re-checked ${rechecked} held, raised ${raised.length} new, ${duplicates} already known`,
    tokens,
    model: env.INGEST_AI_PROVIDER,
    channel: "dream",
  });
  console.log(
    `[mort] dreamt over ${library.length} file(s) and ${docs.length} page(s) — ${raised.length} new proposal(s), ${duplicates} already known`,
  );

  const learned = await runReflection();
  return { raised: raised.length, skipped: duplicates, rechecked, learned };
}

/**
 * The reflection phase (v2/P7): read the last week of what Mort did and how it
 * landed, and write down what to do differently.
 *
 * Runs after the corpus dream and never instead of it — a failure here must not
 * cost the night's proposals. The cap is re-checked between the two because the
 * corpus turn has just spent against it, and a reflection is the more
 * expendable of the two: proposals are about the KB the crew actually use.
 */
async function runReflection(): Promise<number> {
  try {
    if (await dreamSpend.exceeded()) {
      console.warn("[mort] daily token cap reached during the dream — skipping the reflection");
      return 0;
    }

    const signals = await collectReflectionSignals(env.MORT_REFLECT_DAYS);
    if (!worthReflectingOn(signals)) {
      console.log(
        `[mort] nothing to reflect on — ${signals.journal.length} decision(s), no graded proposals, feedback or corrections in the last ${signals.days} day(s)`,
      );
      return 0;
    }

    // Handed the active lessons as DATA so it dedupes against them. They are
    // deliberately NOT in its system prompt: a turn whose job is to judge its
    // own conclusions should not be reading them back as instructions.
    //
    // Every active lesson, not the ones scoped to this channel: the reflection
    // is deciding whether it already holds a thought, and a chat-scoped lesson
    // it can't see is one it will conclude again tonight.
    const existing = await listLessons({ status: "active", limit: 60 }).catch(() => []);
    const { learned, duplicates, tokens, steps } = await runReflectionTurn({ signals, existing });

    await appendJournal({
      action: "reflect",
      rationale:
        `looked over ${signals.days} day(s): ${signals.journal.length} decision(s), ${signals.reviews.length} graded ` +
        `proposal(s), ${signals.feedback.length} rating(s) — learnt ${learned.length} over ${steps} step(s), ` +
        `${duplicates} already known`,
      tokens,
      model: env.INGEST_AI_PROVIDER,
      channel: "dream",
      // The lessons themselves live in mort_lessons; the journal records that a
      // reflection happened and what came out of it, so the activity panel can
      // show it alongside everything else Mort did.
      details: { learned: learned.map((l) => l.lesson) },
    });
    for (const l of learned) console.log(`[mort] learnt: ${l.lesson}`);
    return learned.length;
  } catch (err) {
    // Never let the reflection take the dream down with it: the proposals are
    // already raised and the lessons can wait for tomorrow night.
    console.error("[mort] reflection failed:", err);
    return 0;
  }
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
  const file = {
    sourceId: job.sourceId,
    fileName: job.fileName,
    folderPath: job.folderPath ?? undefined,
    contentType: job.contentType,
    extractedMarkdown: extraction.markdown,
    extractionKind: extraction.kind,
  };

  // Which engine decides (v2/P6). Read per job rather than cached at boot, so
  // an admin flipping it — or rolling it back — takes effect on the next file
  // instead of the next deploy. Both engines produce the same TurnOutcome and
  // write the same journal row; everything downstream of here is identical.
  const engine = await getIngestEngine();
  const outcome =
    engine === "agent"
      ? await runMortAgentTurn(file, role, d)
      : await runMortTurn(
          file,
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
    `[mort] ${job.sourceId} (${engine}): ${outcome.decided} → ${outcome.executed}${outcome.docId ? ` (${outcome.docId})` : ""} — ${outcome.understanding.summary}`,
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
