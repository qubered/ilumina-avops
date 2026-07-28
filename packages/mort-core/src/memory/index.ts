import { pool } from "./db";
import { withKeyLock } from "./lock";
import type {
  DocEntry,
  EventRow,
  FileRole,
  LibraryEntry,
  MortDoc,
  MortDocState,
  MortSource,
  RelationKind,
  ReviewItem,
} from "./types";

/**
 * Repository over Mort's memory tables. Thin, typed wrappers — no business
 * logic (that lives in the decision core, P2). Everything here is safe to call
 * from the ingest worker.
 */

// --- Registry key ----------------------------------------------------------

/**
 * Deterministic dedup key for a doc — the doc's SEMANTIC identity (R4).
 *
 * Deliberately excludes folder origin: the same logical page arriving from two
 * different folders must resolve to ONE doc, not two near-duplicates. Folder is
 * still a strong placement hint (it seeds the search query) and is preserved on
 * the doc + in its header for traceability — it just no longer defines identity.
 */
export function registryKey(parts: { system?: string | null; title: string }): string {
  return [parts.system ?? "", parts.title]
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");
}

// --- Sources (corpus map) --------------------------------------------------

export async function upsertSource(src: {
  sourceId: string;
  checksum?: string | null;
  role?: FileRole;
  folderOrigin?: string | null;
  summary?: string | null;
  zone?: string[];
  system?: string[];
  entities?: string[];
}): Promise<void> {
  await pool.query(
    // The ::text[] casts matter: COALESCE($6,'{}') types the bare '{}' as text,
    // so the whole expression comes out text and clashes with the text[] column.
    `INSERT INTO mort_sources (source_id, checksum, role, folder_origin, summary, zone, system, entities, status, updated_at)
     VALUES ($1, $2, COALESCE($3,'unknown'), $4, $5,
             COALESCE($6::text[],'{}'), COALESCE($7::text[],'{}'), COALESCE($8::text[],'{}'), 'active', now())
     ON CONFLICT (source_id) DO UPDATE SET
       checksum = EXCLUDED.checksum,
       role = COALESCE(EXCLUDED.role, mort_sources.role),
       folder_origin = EXCLUDED.folder_origin,
       summary = COALESCE(EXCLUDED.summary, mort_sources.summary),
       zone = COALESCE(EXCLUDED.zone, mort_sources.zone),
       system = COALESCE(EXCLUDED.system, mort_sources.system),
       entities = COALESCE(EXCLUDED.entities, mort_sources.entities),
       status = 'active',
       updated_at = now()`,
    [
      src.sourceId,
      src.checksum ?? null,
      src.role ?? null,
      src.folderOrigin ?? null,
      src.summary ?? null,
      src.zone?.length ? src.zone : null,
      src.system?.length ? src.system : null,
      src.entities?.length ? src.entities : null,
    ],
  );
}

/**
 * Other files in the library that look related to this one — same folder, or
 * overlapping system/entities. This is what lets Mort "look at the other files
 * he has" when deciding, rather than only searching the published KB.
 */
export async function listRelatedSources(params: {
  excludeSourceId: string;
  folderOrigin?: string | null;
  system?: string[];
  entities?: string[];
  limit?: number;
}): Promise<Array<{ sourceId: string; role: string; summary: string | null }>> {
  const { rows } = await pool.query(
    `SELECT source_id, role, summary FROM mort_sources
      WHERE status = 'active'
        AND source_id <> $1
        AND ( ($2::text   IS NOT NULL AND folder_origin = $2)
           OR ($3::text[] IS NOT NULL AND system   && $3::text[])
           OR ($4::text[] IS NOT NULL AND entities && $4::text[]) )
      ORDER BY updated_at DESC
      LIMIT $5`,
    [
      params.excludeSourceId,
      params.folderOrigin ?? null,
      params.system?.length ? params.system : null,
      params.entities?.length ? params.entities : null,
      Math.min(Math.max(params.limit ?? 12, 1), 30),
    ],
  );
  return rows.map((r) => ({ sourceId: r.source_id, role: r.role, summary: r.summary }));
}

export async function getSource(sourceId: string): Promise<MortSource | null> {
  const { rows } = await pool.query(
    `SELECT source_id, checksum, role, folder_origin, status, summary
       FROM mort_sources WHERE source_id = $1`,
    [sourceId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    sourceId: r.source_id,
    checksum: r.checksum,
    role: r.role as FileRole,
    folderOrigin: r.folder_origin,
    status: r.status,
    summary: r.summary,
  };
}

/** Mark a source tombstoned (fail-closed deletion — the file vanished locally). */
export async function tombstoneSource(sourceId: string): Promise<void> {
  await pool.query(
    `UPDATE mort_sources SET status = 'tombstoned', updated_at = now() WHERE source_id = $1`,
    [sourceId],
  );
}

/** Rebind a source to a new path (rename = move, not delete+create). */
export async function renameSource(oldId: string, newId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE mort_sources SET source_id = $2, updated_at = now() WHERE source_id = $1`, [oldId, newId]);
    await client.query(`UPDATE mort_source_doc_relations SET source_id = $2 WHERE source_id = $1`, [oldId, newId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// --- Docs + relations ------------------------------------------------------

export async function findDocByRegistryKey(key: string): Promise<MortDoc | null> {
  const { rows } = await pool.query(
    `SELECT mort_id, outline_document_id, collection, title, folder_origin, system, registry_key
       FROM mort_docs WHERE registry_key = $1`,
    [key],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    mortId: r.mort_id,
    outlineDocumentId: r.outline_document_id,
    collection: r.collection,
    title: r.title,
    folderOrigin: r.folder_origin,
    system: r.system,
    registryKey: r.registry_key,
  };
}

/**
 * Insert a doc if its registry key is free; if a concurrent create already
 * claimed the key, returns the existing doc (so the caller converts to an
 * additive update instead of duplicating).
 */
export async function claimDoc(doc: MortDoc): Promise<{ doc: MortDoc; created: boolean }> {
  const { rows } = await pool.query(
    `INSERT INTO mort_docs (mort_id, outline_document_id, collection, title, folder_origin, system, registry_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (registry_key) DO NOTHING
     RETURNING mort_id`,
    [doc.mortId, doc.outlineDocumentId, doc.collection, doc.title, doc.folderOrigin, doc.system, doc.registryKey],
  );
  if (rows.length) return { doc, created: true };
  const existing = await findDocByRegistryKey(doc.registryKey);
  return { doc: existing!, created: false };
}

/**
 * Forget a doc Mort thought he maintained — used when the registry points at a
 * document that no longer exists in Outline (someone deleted it). Without this,
 * the stale row makes every future write to that logical doc 403 forever.
 */
export async function forgetDoc(mortId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT outline_document_id FROM mort_docs WHERE mort_id = $1`, [mortId]);
    const outlineId = rows[0]?.outline_document_id as string | undefined;
    await client.query(`DELETE FROM mort_source_doc_relations WHERE mort_id = $1`, [mortId]);
    if (outlineId) await client.query(`DELETE FROM mort_doc_state WHERE outline_document_id = $1`, [outlineId]);
    await client.query(`DELETE FROM mort_docs WHERE mort_id = $1`, [mortId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function findMortIdByOutlineId(outlineDocumentId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT mort_id FROM mort_docs WHERE outline_document_id = $1 LIMIT 1`, [outlineDocumentId]);
  return rows.length ? (rows[0].mort_id as string) : null;
}

export async function addRelation(sourceId: string, mortId: string, relation: RelationKind): Promise<void> {
  await pool.query(
    `INSERT INTO mort_source_doc_relations (source_id, mort_id, relation)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [sourceId, mortId, relation],
  );
}

/** All docs a source touched, with the relation and the Outline id. */
export async function getSourceRelations(
  sourceId: string,
): Promise<Array<{ mortId: string; relation: RelationKind; outlineDocumentId: string }>> {
  const { rows } = await pool.query(
    `SELECT r.mort_id, r.relation, d.outline_document_id
       FROM mort_source_doc_relations r JOIN mort_docs d ON d.mort_id = r.mort_id
      WHERE r.source_id = $1`,
    [sourceId],
  );
  return rows.map((r) => ({ mortId: r.mort_id, relation: r.relation, outlineDocumentId: r.outline_document_id }));
}

/** How many distinct sources authored a doc — 1 means the doc has a sole author. */
export async function countAuthors(mortId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT source_id)::int AS n FROM mort_source_doc_relations WHERE mort_id = $1 AND relation = 'authored'`,
    [mortId],
  );
  return rows[0]?.n ?? 0;
}

export async function deleteSourceRelations(sourceId: string): Promise<void> {
  await pool.query(`DELETE FROM mort_source_doc_relations WHERE source_id = $1`, [sourceId]);
}

// --- Journal ---------------------------------------------------------------

/**
 * Which door an entry came through. `admin` is the console; `chat` is a
 * conversation; `ingest` is a file turn; `dream` is the nightly reflection.
 */
export type JournalChannel = "chat" | "ingest" | "dream" | "admin";

export async function appendJournal(entry: {
  sourceId?: string | null;
  /** A real mort_id (Mort's canonical slug) — NOT an Outline document id, see outlineDocumentId. */
  mortId?: string | null;
  /** An Outline document id — what most call sites actually have at journal time. */
  outlineDocumentId?: string | null;
  action: string;
  rationale?: string | null;
  confidence?: number | null;
  model?: string | null;
  tokens?: number | null;
  costUsd?: number | null;
  conflicts?: unknown;
  /**
   * Provenance (P2). Required so no call site can quietly log an unattributed
   * decision: every entry says which door it came through. `actor` defaults to
   * the literal 'system' for machine-initiated turns — it must come from a
   * session or a job, never from model output.
   */
  channel: JournalChannel;
  actor?: string | null;
  conversationId?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO mort_journal (source_id, mort_id, outline_document_id, action, rationale, confidence, model, tokens, cost_usd, conflicts, actor, channel, conversation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      entry.sourceId ?? null,
      entry.mortId ?? null,
      entry.outlineDocumentId ?? null,
      entry.action,
      entry.rationale ?? null,
      entry.confidence ?? null,
      entry.model ?? null,
      entry.tokens ?? null,
      entry.costUsd ?? null,
      entry.conflicts != null ? JSON.stringify(entry.conflicts) : null,
      entry.actor ?? "system",
      entry.channel,
      entry.conversationId ?? null,
    ],
  );
}

// --- Doc state (curated detection + CAS) -----------------------------------

export async function getDocState(outlineDocumentId: string): Promise<MortDocState | null> {
  const { rows } = await pool.query(
    `SELECT outline_document_id, last_mort_revision_id, last_mort_body_hash
       FROM mort_doc_state WHERE outline_document_id = $1`,
    [outlineDocumentId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    outlineDocumentId: r.outline_document_id,
    lastMortRevisionId: r.last_mort_revision_id,
    lastMortBodyHash: r.last_mort_body_hash,
  };
}

export async function recordDocState(state: MortDocState): Promise<void> {
  await pool.query(
    `INSERT INTO mort_doc_state (outline_document_id, last_mort_revision_id, last_mort_body_hash, last_mort_ts)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (outline_document_id) DO UPDATE SET
       last_mort_revision_id = EXCLUDED.last_mort_revision_id,
       last_mort_body_hash = EXCLUDED.last_mort_body_hash,
       last_mort_ts = now()`,
    [state.outlineDocumentId, state.lastMortRevisionId, state.lastMortBodyHash],
  );
}

// --- Review queue ----------------------------------------------------------

/** Enqueue a proposal for human review. Idempotent on dedupeKey. Returns true if newly queued. */
export async function enqueueReview(item: ReviewItem): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO mort_review_queue (action, source_id, mort_id, target_doc_id, payload, rationale, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      item.action,
      item.sourceId ?? null,
      item.mortId ?? null,
      item.targetDocId ?? null,
      item.payload != null ? JSON.stringify(item.payload) : null,
      item.rationale ?? null,
      item.dedupeKey,
    ],
  );
  return rows.length > 0;
}

/** A row from mort_review_queue (snake_case, as stored). */
export type ReviewRow = {
  id: number;
  action: string;
  source_id: string | null;
  mort_id: string | null;
  target_doc_id: string | null;
  payload: { title?: string; collection?: string | null; regionBody?: string } | null;
  rationale: string | null;
  status: string;
  created_at: string;
};

export async function listPendingReviews(limit = 100): Promise<ReviewRow[]> {
  const { rows } = await pool.query(
    `SELECT id::int AS id, action, source_id, mort_id, target_doc_id, payload, rationale, status, created_at
       FROM mort_review_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return rows as ReviewRow[];
}

/**
 * Artifacts in the library that bear on a page Mort just wrote, and aren't on it
 * yet. A page appearing (or growing) changes what its siblings should do: a
 * schematic that arrived before its page had nowhere to go, and one already
 * filed on another page may belong on this one too — a file is not spent when
 * it lands somewhere.
 *
 * Scoped to sources with bytes, since only those can be attached; `excludeMortId`
 * drops the ones already on this doc so a re-check can't loop on its own work.
 */
export async function listAttachableRelatives(params: {
  excludeSourceId: string;
  /** Doc just written — sources already attached to it are skipped. */
  excludeMortId?: string | null;
  folderOrigin?: string | null;
  system?: string[];
  entities?: string[];
  limit?: number;
}): Promise<Array<{ sourceId: string; folderOrigin: string | null; checksum: string | null }>> {
  const { rows } = await pool.query(
    `SELECT s.source_id, s.folder_origin, s.checksum
       FROM mort_sources s
       JOIN mort_blobs b ON b.source_id = s.source_id
      WHERE s.status = 'active'
        AND s.source_id <> $1
        AND ( ($2::text   IS NOT NULL AND s.folder_origin = $2)
           OR ($3::text[] IS NOT NULL AND s.system   && $3::text[])
           OR ($4::text[] IS NOT NULL AND s.entities && $4::text[]) )
        AND ( $5::text IS NULL OR NOT EXISTS (
              SELECT 1 FROM mort_source_doc_relations r
               WHERE r.source_id = s.source_id AND r.mort_id = $5 AND r.relation = 'attached') )
      ORDER BY s.updated_at DESC
      LIMIT $6`,
    [
      params.excludeSourceId,
      params.folderOrigin ?? null,
      params.system?.length ? params.system : null,
      params.entities?.length ? params.entities : null,
      params.excludeMortId ?? null,
      Math.min(Math.max(params.limit ?? 10, 1), 25),
    ],
  );
  return rows.map((r) => ({ sourceId: r.source_id, folderOrigin: r.folder_origin, checksum: r.checksum }));
}

// --- Admin activity feed ---------------------------------------------------

export type ActivityRow = {
  ts: string;
  sourceId: string | null;
  action: string;
  rationale: string | null;
  confidence: number | null;
  tokens: number | null;
  model: string | null;
  /** Title of the page the entry concerns, when it concerns one. */
  docTitle: string | null;
  /** Outline id, so the UI can link straight to the page. */
  outlineDocumentId: string | null;
  /** Who caused it — a user id/email, or 'system' for a machine-initiated turn. */
  actor: string;
  channel: JournalChannel;
  /** Set when the entry came out of a conversation, so the UI can link to it. */
  conversationId: string | null;
};

/**
 * What Mort has been doing, newest first — the journal, made readable.
 *
 * A journal row names EITHER a real mort_id OR an Outline document id (never
 * both, never ambiguously) — see the schema's backfillJournalOutlineIds() for
 * the historical-rows migration. Two clean equalities, not an OR across id
 * spaces.
 */
export async function recentActivity(limit = 50): Promise<ActivityRow[]> {
  const { rows } = await pool.query(
    `SELECT j.ts, j.source_id, j.action, j.rationale, j.confidence, j.tokens, j.model,
            j.actor, j.channel, j.conversation_id,
            d.title AS doc_title, COALESCE(j.outline_document_id, d.outline_document_id) AS outline_document_id
       FROM mort_journal j
       LEFT JOIN mort_docs d
         ON d.mort_id = j.mort_id OR d.outline_document_id = j.outline_document_id
      ORDER BY j.ts DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    sourceId: r.source_id,
    action: r.action,
    rationale: r.rationale,
    confidence: r.confidence,
    tokens: r.tokens,
    model: r.model,
    docTitle: r.doc_title,
    outlineDocumentId: r.outline_document_id,
    actor: r.actor as string,
    channel: r.channel as JournalChannel,
    conversationId: r.conversation_id,
  }));
}

export type LibraryRow = {
  sourceId: string;
  role: string;
  status: string;
  summary: string | null;
  zone: string[];
  system: string[];
  entities: string[];
  updatedAt: string;
  /** How many pages this file feeds — 0 means Mort is holding it. */
  docCount: number;
  /** Whether Mort still has the bytes (so it can be attached to a future page). */
  hasBytes: boolean;
};

/** Every file Mort knows about, with what he made of it. Optionally filtered. */
export async function listLibrary(q?: string, limit = 200): Promise<LibraryRow[]> {
  const like = q?.trim() ? `%${q.trim()}%` : null;
  const { rows } = await pool.query(
    `SELECT s.source_id, s.role, s.status, s.summary, s.zone, s.system, s.entities, s.updated_at,
            (SELECT count(*)::int FROM mort_source_doc_relations r WHERE r.source_id = s.source_id) AS doc_count,
            EXISTS (SELECT 1 FROM mort_blobs b WHERE b.source_id = s.source_id) AS has_bytes
       FROM mort_sources s
      WHERE ($1::text IS NULL OR s.source_id ILIKE $1 OR s.summary ILIKE $1)
      ORDER BY s.updated_at DESC
      LIMIT $2`,
    [like, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r) => ({
    sourceId: r.source_id,
    role: r.role,
    status: r.status,
    summary: r.summary,
    zone: r.zone ?? [],
    system: r.system ?? [],
    entities: r.entities ?? [],
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    docCount: r.doc_count,
    hasBytes: r.has_bytes === true,
  }));
}

/**
 * Artifacts Mort is holding that never found a home: he has the bytes, but they
 * feed no page at all.
 *
 * A file is held when no page it belongs on existed yet, and it's re-checked
 * when one appears. But that trigger is a page WRITE — so once a bulk ingest
 * finishes and the writes stop, anything still held stays held forever, however
 * many pages it now obviously belongs on. This is the list the dream re-checks
 * to close that gap.
 */
export async function listUnfiledArtifacts(limit = 200): Promise<
  Array<{ sourceId: string; folderOrigin: string | null; checksum: string | null }>
> {
  const { rows } = await pool.query(
    `SELECT s.source_id, s.folder_origin, s.checksum
       FROM mort_sources s
       JOIN mort_blobs b ON b.source_id = s.source_id
      WHERE s.status = 'active'
        AND s.checksum IS NOT NULL
        AND NOT EXISTS (
              SELECT 1 FROM mort_source_doc_relations r WHERE r.source_id = s.source_id)
      ORDER BY s.updated_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((r) => ({ sourceId: r.source_id, folderOrigin: r.folder_origin, checksum: r.checksum }));
}

// --- Corpus digests (R7 dream) ---------------------------------------------

/**
 * The whole library, one line each, for the dream pass. Summaries only — never
 * bodies: the point is to see the shape of the corpus at once, which is exactly
 * what a per-file turn cannot do.
 *
 * `hasDoc` is what makes "nothing has been written about these" answerable.
 */
export async function libraryDigest(limit = 400): Promise<LibraryEntry[]> {
  const { rows } = await pool.query(
    `SELECT s.source_id, s.role, s.summary, s.zone, s.system, s.entities,
            EXISTS (SELECT 1 FROM mort_source_doc_relations r WHERE r.source_id = s.source_id) AS has_doc
       FROM mort_sources s
      WHERE s.status = 'active' AND s.role <> 'event_log'
      ORDER BY s.updated_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 1000)],
  );
  return rows.map((r) => ({
    sourceId: r.source_id,
    role: r.role,
    summary: r.summary,
    zone: r.zone ?? [],
    system: r.system ?? [],
    entities: r.entities ?? [],
    hasDoc: r.has_doc === true,
  }));
}

/** Every page Mort maintains, for the dream pass. */
export async function docDigest(limit = 300): Promise<DocEntry[]> {
  const { rows } = await pool.query(
    `SELECT d.mort_id, d.outline_document_id, d.title, d.system, d.collection,
            (SELECT count(*)::int FROM mort_source_doc_relations r WHERE r.mort_id = d.mort_id) AS source_count
       FROM mort_docs d
      ORDER BY d.updated_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 1000)],
  );
  return rows.map((r) => ({
    mortId: r.mort_id,
    outlineDocumentId: r.outline_document_id,
    title: r.title,
    system: r.system,
    collection: r.collection,
    sourceCount: r.source_count,
  }));
}

// --- Current-state facts (R1 slice 3) --------------------------------------

/** Which door a fact was taught through (P2 provenance). */
export type TaughtVia = "chat" | "admin" | "ingest";

/**
 * A fact's window is HALF-OPEN: in force from `effectiveFrom` (inclusive) until
 * `effectiveTo` (exclusive). Retiring a fact today therefore stamps today — it
 * stops being true now, not at midnight — and superseding one stamps the
 * successor's start date, so exactly one row in a chain is ever current.
 */
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
  /** When it was learnt — the wall-clock moment, as opposed to the date it took effect. */
  createdAt: string;
  taughtVia: TaughtVia;
  /** Set for chat-taught facts: the conversation, and the message that said it. */
  conversationId: string | null;
  messageId: string | null;
  /** The fact this one replaced, when it corrected an earlier answer. */
  supersedes: number | null;
};

const mapFact = (r: Record<string, unknown>): MortFact => ({
  id: r.id as number,
  factKey: r.fact_key as string,
  value: r.value as string,
  scope: (r.scope as string) ?? null,
  effectiveFrom: r.effective_from ? String(r.effective_from).slice(0, 10) : null,
  effectiveTo: r.effective_to ? String(r.effective_to).slice(0, 10) : null,
  sourceTier: (r.source_tier as string) ?? null,
  approvedBy: r.approved_by as string,
  confidence: (r.confidence as string) ?? null,
  note: (r.note as string) ?? null,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
  taughtVia: (r.taught_via as TaughtVia) ?? "admin",
  conversationId: (r.conversation_id as string) ?? null,
  messageId: (r.message_id as string) ?? null,
  supersedes: (r.supersedes as number) ?? null,
});

const FACT_COLS = `id::int AS id, fact_key, value, scope, effective_from, effective_to,
                   source_tier, approved_by, confidence, note, created_at,
                   taught_via, conversation_id, message_id, supersedes::int AS supersedes`;

/** Facts in force today, optionally filtered by free text. */
export async function listCurrentFacts(q?: string, limit = 25): Promise<MortFact[]> {
  const like = q?.trim() ? `%${q.trim()}%` : null;
  const { rows } = await pool.query(
    `SELECT ${FACT_COLS}
       FROM mort_facts
      WHERE (effective_from IS NULL OR effective_from <= CURRENT_DATE)
        AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
        AND ($1::text IS NULL OR fact_key ILIKE $1 OR value ILIKE $1 OR scope ILIKE $1 OR note ILIKE $1)
      ORDER BY effective_from DESC NULLS LAST, id DESC
      LIMIT $2`,
    [like, Math.min(Math.max(limit, 1), 50)],
  );
  return rows.map(mapFact);
}

export async function getFact(id: number): Promise<MortFact | null> {
  const { rows } = await pool.query(`SELECT ${FACT_COLS} FROM mort_facts WHERE id = $1`, [id]);
  return rows.length ? mapFact(rows[0]) : null;
}

/**
 * The fact currently answering this exact key AND scope — what a new statement
 * about the same thing would replace.
 *
 * Both halves are matched exactly (case- and whitespace-insensitively), and a
 * missing scope matches only a missing scope: superseding the wrong fact is
 * worse than not superseding one, and "the LED wall is at 6m" said with no
 * zone in mind must not silently retire the Main Stage's answer.
 */
export async function findCurrentFactByKey(factKey: string, scope?: string | null): Promise<MortFact | null> {
  const { rows } = await pool.query(
    `SELECT ${FACT_COLS}
       FROM mort_facts
      WHERE lower(btrim(fact_key)) = lower(btrim($1))
        AND lower(btrim(coalesce(scope,''))) = lower(btrim(coalesce($2::text,'')))
        AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
        AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
      ORDER BY effective_from DESC NULLS LAST, id DESC
      LIMIT 1`,
    [factKey, scope ?? null],
  );
  return rows.length ? mapFact(rows[0]) : null;
}

/**
 * Provenance for a declared fact (P2): which door it came through and, for
 * anything said in conversation, exactly which message said it — so an answer
 * can deep-link back to the moment it was learnt. Never model-supplied; the
 * caller stamps it from the session.
 */
export type FactProvenance = {
  taughtVia?: TaughtVia;
  conversationId?: string | null;
  messageId?: string | null;
};

export type FactInput = {
  factKey: string;
  value: string;
  scope?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  sourceTier?: string | null;
  approvedBy: string;
  confidence?: string | null;
  note?: string | null;
  /** id of the fact this one replaces — the history chain (MORT_V2_PLAN I.7). */
  supersedes?: number | null;
} & FactProvenance;

export async function insertFact(f: FactInput): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO mort_facts (fact_key, value, scope, effective_from, effective_to, source_tier, approved_by, confidence, note,
                             supersedes, taught_via, conversation_id, message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id::int AS id`,
    [
      f.factKey,
      f.value,
      f.scope ?? null,
      f.effectiveFrom ?? null,
      f.effectiveTo ?? null,
      f.sourceTier ?? "human",
      f.approvedBy,
      f.confidence ?? null,
      f.note ?? null,
      f.supersedes ?? null,
      // 'admin' is the honest default: the console is the only caller that
      // doesn't say, because it is the door v1 facts all came through.
      f.taughtVia ?? "admin",
      f.conversationId ?? null,
      f.messageId ?? null,
    ],
  );
  return rows[0].id as number;
}

/**
 * Declare a fact, superseding whatever currently answers the same key+scope.
 *
 * This is the ONE way a fact is declared, whether it came from the admin panel
 * or from someone telling Mort in chat: the previous row is closed off at the
 * new one's start date and the new row points back at it, so a fact's history
 * is a chain rather than an overwrite (MORT_V2_PLAN I.7, wiring the `supersedes`
 * column v1 defined but never used).
 *
 * Held under the per-key advisory lock: two people teaching the same key at
 * once would otherwise both find no current row and both insert, leaving the
 * key with two live values and no supersession between them.
 */
export function saveFactSuperseding(
  f: Omit<FactInput, "effectiveTo" | "supersedes">,
): Promise<{ id: number; superseded: MortFact | null; effectiveFrom: string }> {
  return withKeyLock("fact", `${f.factKey.trim().toLowerCase()}|${(f.scope ?? "").trim().toLowerCase()}`, async () => {
    const effectiveFrom = f.effectiveFrom ?? new Date().toISOString().slice(0, 10);
    const superseded = await findCurrentFactByKey(f.factKey, f.scope ?? null);
    if (superseded) await retireFact(superseded.id, effectiveFrom);
    const id = await insertFact({ ...f, effectiveFrom, supersedes: superseded?.id ?? null });
    return { id, superseded, effectiveFrom };
  });
}

/**
 * The full life of a fact key, newest first — "what is it, and what was it
 * before?" answered from data rather than from the model's memory of the
 * conversation. Every row carries its own provenance, so each step of the
 * chain can name who said it and when.
 */
export async function factHistory(
  factKey: string,
  opts: { scope?: string | null; limit?: number } = {},
): Promise<MortFact[]> {
  // Omitting `scope` means "every scope"; passing it explicitly — including as
  // null — narrows to that one, because an unscoped fact is its own fact.
  const narrow = "scope" in opts;
  const { rows } = await pool.query(
    `SELECT ${FACT_COLS} FROM mort_facts
      WHERE lower(btrim(fact_key)) = lower(btrim($1))
        AND ($2::boolean IS FALSE
             OR lower(btrim(coalesce(scope,''))) = lower(btrim(coalesce($3::text,''))))
      ORDER BY id DESC
      LIMIT $4`,
    [factKey, narrow, opts.scope ?? null, Math.min(Math.max(opts.limit ?? 20, 1), 50)],
  );
  return rows.map(mapFact);
}

/**
 * Close a fact off. `asOf` (ISO date) is the exclusive end of its window —
 * defaults to today, i.e. "it isn't true any more, starting now". Superseding
 * passes the successor's start date so the two windows abut exactly.
 */
export async function retireFact(id: number, asOf?: string | null): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE mort_facts SET effective_to = COALESCE($2::date, CURRENT_DATE)
      WHERE id = $1 AND (effective_to IS NULL OR effective_to > COALESCE($2::date, CURRENT_DATE))`,
    [id, asOf ?? null],
  );
  return (rowCount ?? 0) > 0;
}

// --- Memory search (read-only, for the chat's mort_memory tool) -------------

export type MemoryJournalRow = {
  ts: string;
  sourceId: string | null;
  mortId: string | null;
  action: string;
  rationale: string | null;
  confidence: number | null;
  /** P2: who and through which door — so "why did you do that?" also answers "on whose say-so?". */
  actor: string;
  channel: JournalChannel;
  conversationId: string | null;
};
export type MemoryFileRow = { sourceId: string; role: string; folderOrigin: string | null; summary: string | null };

const JOURNAL_COLS = `ts, source_id, mort_id, action, rationale, confidence, actor, channel, conversation_id`;
const mapJournal = (r: Record<string, unknown>): MemoryJournalRow => ({
  ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
  sourceId: (r.source_id as string) ?? null,
  mortId: (r.mort_id as string) ?? null,
  action: r.action as string,
  rationale: (r.rationale as string) ?? null,
  confidence: (r.confidence as number) ?? null,
  actor: (r.actor as string) ?? "system",
  channel: (r.channel as JournalChannel) ?? "ingest",
  conversationId: (r.conversation_id as string) ?? null,
});
const mapFile = (r: Record<string, unknown>): MemoryFileRow => ({
  sourceId: r.source_id as string,
  role: r.role as string,
  folderOrigin: (r.folder_origin as string) ?? null,
  summary: (r.summary as string) ?? null,
});

/**
 * Look up Mort's own history: why he did something, what he changed recently,
 * and which source files feed a doc. Read-only.
 */
export async function searchMemory(params: { q?: string; docId?: string; limit?: number }): Promise<{
  journal: MemoryJournalRow[];
  files: MemoryFileRow[];
}> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);

  if (params.docId) {
    // params.docId may be either a real mort_id or an Outline document id —
    // callers don't always know which. mort_journal now records the two in
    // separate columns (never ambiguously), so match either column directly
    // instead of cross-referencing through mort_docs.
    const { rows: jr } = await pool.query(
      `SELECT ${JOURNAL_COLS} FROM mort_journal
        WHERE mort_id = $1 OR outline_document_id = $1
        ORDER BY ts DESC LIMIT $2`,
      [params.docId, limit],
    );
    const { rows: fr } = await pool.query(
      `SELECT s.source_id, s.role, s.folder_origin, s.summary
         FROM mort_source_doc_relations r
         JOIN mort_sources s ON s.source_id = r.source_id
         JOIN mort_docs d ON d.mort_id = r.mort_id
        WHERE d.mort_id = $1 OR d.outline_document_id = $1
        LIMIT $2`,
      [params.docId, limit],
    );
    return { journal: jr.map(mapJournal), files: fr.map(mapFile) };
  }

  const q = params.q?.trim();
  if (q) {
    const like = `%${q}%`;
    const { rows: jr } = await pool.query(
      // actor is searchable so "what has Jayden had me change?" / "who told
      // you that?" resolve out of the journal rather than out of thin air.
      `SELECT ${JOURNAL_COLS} FROM mort_journal
        WHERE source_id ILIKE $1 OR rationale ILIKE $1 OR action ILIKE $1
           OR mort_id ILIKE $1 OR outline_document_id ILIKE $1 OR actor ILIKE $1
        ORDER BY ts DESC LIMIT $2`,
      [like, limit],
    );
    const { rows: fr } = await pool.query(
      `SELECT source_id, role, folder_origin, summary FROM mort_sources
        WHERE source_id ILIKE $1 OR summary ILIKE $1 ORDER BY updated_at DESC LIMIT $2`,
      [like, limit],
    );
    return { journal: jr.map(mapJournal), files: fr.map(mapFile) };
  }

  // No filter → most recent activity ("what did you change this week?").
  const { rows } = await pool.query(`SELECT ${JOURNAL_COLS} FROM mort_journal ORDER BY ts DESC LIMIT $1`, [limit]);
  return { journal: rows.map(mapJournal), files: [] };
}

// --- Events (episodic memory) ----------------------------------------------

export async function getEventHashes(sourceId: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT row_hash FROM mort_events WHERE source_id = $1`, [sourceId]);
  return rows.map((r) => r.row_hash as string);
}

/**
 * Provenance for an episodic event (P2). Sheet rows have none — the file named
 * by `source_id` is the provenance — so both fields are optional and stay null
 * for the ingest path.
 */
export type EventProvenance = { reportedBy?: string | null; conversationId?: string | null };

export async function insertEvent(
  sourceId: string,
  row: EventRow,
  provenance: EventProvenance = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO mort_events (source_id, row_hash, event, occurred_on, zone, system, entities, action_text, reported_by, conversation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (source_id, row_hash) DO NOTHING`,
    [
      sourceId,
      row.rowHash,
      row.event,
      row.occurredOn,
      row.zone,
      row.system,
      row.entities,
      row.actionText,
      provenance.reportedBy ?? null,
      provenance.conversationId ?? null,
    ],
  );
}

/**
 * Provenance for events already in episodic memory, keyed by (source, row).
 * The vector store is the search index but not the record of who said what —
 * points indexed before P2 have no provenance in their payload, so the answer
 * path reads it back from Postgres, which always has it.
 */
export async function eventProvenance(
  keys: Array<{ sourceId: string; rowHash: string }>,
): Promise<Map<string, EventProvenance & { occurredOn: string | null }>> {
  const out = new Map<string, EventProvenance & { occurredOn: string | null }>();
  if (!keys.length) return out;
  const { rows } = await pool.query(
    `SELECT source_id, row_hash, reported_by, conversation_id, occurred_on
       FROM mort_events
      WHERE (source_id, row_hash) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [keys.map((k) => k.sourceId), keys.map((k) => k.rowHash)],
  );
  for (const r of rows) {
    out.set(`${r.source_id} ${r.row_hash}`, {
      reportedBy: (r.reported_by as string) ?? null,
      conversationId: (r.conversation_id as string) ?? null,
      occurredOn: r.occurred_on ? String(r.occurred_on).slice(0, 10) : null,
    });
  }
  return out;
}

export async function deleteEventsByHash(sourceId: string, hashes: string[]): Promise<void> {
  if (!hashes.length) return;
  await pool.query(`DELETE FROM mort_events WHERE source_id = $1 AND row_hash = ANY($2)`, [sourceId, hashes]);
}

// --- Blobs (pending-attachment bytes) --------------------------------------

export type MortBlob = { fileName: string; contentType: string; data: Buffer };

export async function saveBlob(sourceId: string, blob: MortBlob): Promise<void> {
  await pool.query(
    `INSERT INTO mort_blobs (source_id, file_name, content_type, data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_id) DO UPDATE SET
       file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type,
       data = EXCLUDED.data, created_at = now()`,
    [sourceId, blob.fileName, blob.contentType, blob.data],
  );
}

export async function getBlob(sourceId: string): Promise<MortBlob | null> {
  const { rows } = await pool.query(
    `SELECT file_name, content_type, data FROM mort_blobs WHERE source_id = $1`,
    [sourceId],
  );
  if (!rows.length) return null;
  return { fileName: rows[0].file_name, contentType: rows[0].content_type, data: rows[0].data as Buffer };
}

export async function deleteBlob(sourceId: string): Promise<void> {
  await pool.query(`DELETE FROM mort_blobs WHERE source_id = $1`, [sourceId]);
}

// --- Runtime settings ------------------------------------------------------

export async function getSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT value FROM mort_settings WHERE key = $1`, [key]);
  return rows.length ? (rows[0].value as string) : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO mort_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

export async function getReviewItem(id: number): Promise<ReviewRow | null> {
  const { rows } = await pool.query(
    `SELECT id::int AS id, action, source_id, mort_id, target_doc_id, payload, rationale, status, created_at
       FROM mort_review_queue WHERE id = $1`,
    [id],
  );
  return rows.length ? (rows[0] as ReviewRow) : null;
}

/** Mark a proposal decided. Only transitions a pending item; returns false if it wasn't pending. */
export async function resolveReview(id: number, status: "approved" | "rejected", decidedBy?: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE mort_review_queue SET status = $2, decided_at = now(), decided_by = $3
       WHERE id = $1 AND status = 'pending'`,
    [id, status, decidedBy ?? null],
  );
  return (rowCount ?? 0) > 0;
}
