import "../src/preload.js";
import pg from "pg";
import { env } from "../src/env.js";
import { deleteDocument } from "../src/outline.js";

/**
 * Wipe Mort's brain and the pages he wrote. Start over from an empty KB.
 *
 * Dry-run by default — it prints exactly what it would destroy and changes
 * nothing. Pass --yes to actually do it.
 *
 *   docker compose exec ingest npx tsx scripts/reset-mort.ts          # show me
 *   docker compose exec ingest npx tsx scripts/reset-mort.ts --yes    # do it
 *
 * ORDER MATTERS. mort_docs is the only record of which Outline documents are
 * Mort's, so the pages must go before the table that names them. Truncate first
 * and those pages are orphaned in Outline with nothing left that knows they were
 * his — you'd be deleting them by hand.
 *
 * This does NOT touch Qdrant (the assistant owns it) or the watcher's manifest
 * (it's on the OneDrive machine). See RESET.md — a half-reset is worse than
 * none, because Mort comes back up believing things that are no longer true.
 */

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

/** Every table that holds something Mort learned, derived, or was told. */
const TABLES = [
  "mort_journal",
  "mort_source_doc_relations",
  "mort_doc_state",
  "mort_review_queue",
  "mort_blobs",
  "mort_events",
  "mort_facts",
  "mort_jobs",
  "mort_settings",
  "mort_docs",
  "mort_sources",
  // The pre-Mort ingest's dedup map. Only consulted when MORT_MODE=off — which
  // is the env default, so a stale row here would silently skip a re-ingest at
  // exactly the moment you're trying to rebuild from nothing.
  "sharepoint_imports",
];

async function countOf(table: string): Promise<number> {
  try {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]?.n ?? 0;
  } catch {
    return -1; // table doesn't exist yet — nothing to wipe
  }
}

/** Outline docs this stack created: Mort's registry plus the legacy import map. */
async function ingestOwnedDocs(): Promise<Array<{ id: string; title: string; via: string }>> {
  const docs = new Map<string, { id: string; title: string; via: string }>();
  try {
    const { rows } = await pool.query(`SELECT outline_document_id, title FROM mort_docs`);
    for (const r of rows) docs.set(r.outline_document_id, { id: r.outline_document_id, title: r.title, via: "mort" });
  } catch {
    /* no mort_docs yet */
  }
  try {
    const { rows } = await pool.query(`SELECT outline_document_id, title FROM sharepoint_imports`);
    for (const r of rows) {
      if (!docs.has(r.outline_document_id)) {
        docs.set(r.outline_document_id, { id: r.outline_document_id, title: r.title ?? "(untitled)", via: "legacy" });
      }
    }
  } catch {
    /* no sharepoint_imports yet */
  }
  return [...docs.values()];
}

async function main(): Promise<void> {
  const go = process.argv.includes("--yes");

  const docs = await ingestOwnedDocs();
  const counts = await Promise.all(TABLES.map(async (t) => [t, await countOf(t)] as const));

  console.log(`\nMort reset — ${env.OUTLINE_URL}\n`);

  console.log(`Outline pages this stack created: ${docs.length}`);
  for (const d of docs.slice(0, 40)) console.log(`  - [${d.via}] ${d.title}`);
  if (docs.length > 40) console.log(`  … and ${docs.length - 40} more`);

  console.log(`\nPostgres rows to drop:`);
  let total = 0;
  for (const [table, n] of counts) {
    if (n < 0) console.log(`  ${table.padEnd(28)} (no table yet)`);
    else {
      console.log(`  ${table.padEnd(28)} ${n}`);
      total += n;
    }
  }

  if (!go) {
    console.log(
      `\nDRY RUN — nothing was touched. ${docs.length} page(s) and ${total} row(s) would go.\n` +
        `Re-run with --yes to do it.\n`,
    );
    await pool.end();
    return;
  }

  console.log(`\nDeleting ${docs.length} Outline page(s)…`);
  let deleted = 0;
  let failed = 0;
  for (const d of docs) {
    try {
      await deleteDocument(d.id);
      deleted++;
    } catch (err) {
      // Already gone by hand is a success, not a failure — the goal is "not
      // there", and it already isn't.
      const msg = err instanceof Error ? err.message : String(err);
      if (/\((403|404)\)/.test(msg)) deleted++;
      else {
        failed++;
        console.warn(`  couldn't delete "${d.title}": ${msg}`);
      }
    }
  }
  console.log(`  ${deleted} gone${failed ? `, ${failed} failed` : ""}`);

  if (failed) {
    // Truncating now would orphan those pages: they'd sit in Outline with
    // nothing left recording that Mort made them, and he'd write duplicates
    // beside them on the next ingest.
    console.error(
      `\nSTOPPED — ${failed} page(s) could not be deleted, so the tables were left alone.\n` +
        `Fix the access (or delete those pages by hand), then re-run.\n`,
    );
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const existing = counts.filter(([, n]) => n >= 0).map(([t]) => t);
  await pool.query(`TRUNCATE ${existing.join(", ")} RESTART IDENTITY`);
  console.log(`Truncated ${existing.length} table(s).`);

  console.log(
    `\nDone. Mort remembers nothing.\n\n` +
      `Still to do (see ingest/RESET.md):\n` +
      `  1. Clear Qdrant  — the assistant owns it; the KB index still points at deleted pages\n` +
      `  2. Clear the watcher manifest on the OneDrive PC, or it won't resend anything\n` +
      `  3. Set the mode  — mort_settings is gone, so Mort is back to MORT_MODE (${env.MORT_MODE})\n`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
