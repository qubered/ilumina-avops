import { pool } from "./db.js";
import type {
  FileRole,
  MortDoc,
  MortDocState,
  MortSource,
  RelationKind,
  ReviewItem,
} from "./types.js";

/**
 * Repository over Mort's memory tables. Thin, typed wrappers — no business
 * logic (that lives in the decision core, P2). Everything here is safe to call
 * from the ingest worker.
 */

// --- Registry key ----------------------------------------------------------

/** Deterministic dedup key for a doc: lower-cased, whitespace-collapsed. */
export function registryKey(parts: {
  folderOrigin?: string | null;
  system?: string | null;
  title: string;
}): string {
  return [parts.folderOrigin ?? "", parts.system ?? "", parts.title]
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
}): Promise<void> {
  await pool.query(
    `INSERT INTO mort_sources (source_id, checksum, role, folder_origin, summary, status, updated_at)
     VALUES ($1, $2, COALESCE($3,'unknown'), $4, $5, 'active', now())
     ON CONFLICT (source_id) DO UPDATE SET
       checksum = EXCLUDED.checksum,
       role = COALESCE(EXCLUDED.role, mort_sources.role),
       folder_origin = EXCLUDED.folder_origin,
       summary = COALESCE(EXCLUDED.summary, mort_sources.summary),
       status = 'active',
       updated_at = now()`,
    [src.sourceId, src.checksum ?? null, src.role ?? null, src.folderOrigin ?? null, src.summary ?? null],
  );
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

// --- Journal ---------------------------------------------------------------

export async function appendJournal(entry: {
  sourceId?: string | null;
  mortId?: string | null;
  action: string;
  rationale?: string | null;
  confidence?: number | null;
  model?: string | null;
  tokens?: number | null;
  costUsd?: number | null;
  conflicts?: unknown;
}): Promise<void> {
  await pool.query(
    `INSERT INTO mort_journal (source_id, mort_id, action, rationale, confidence, model, tokens, cost_usd, conflicts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entry.sourceId ?? null,
      entry.mortId ?? null,
      entry.action,
      entry.rationale ?? null,
      entry.confidence ?? null,
      entry.model ?? null,
      entry.tokens ?? null,
      entry.costUsd ?? null,
      entry.conflicts != null ? JSON.stringify(entry.conflicts) : null,
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
    `SELECT id, action, source_id, mort_id, target_doc_id, payload, rationale, status, created_at
       FROM mort_review_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return rows as ReviewRow[];
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
    `SELECT id, action, source_id, mort_id, target_doc_id, payload, rationale, status, created_at
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
