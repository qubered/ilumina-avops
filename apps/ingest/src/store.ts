import { createHash } from "node:crypto";
import pg from "pg";
import { env } from "./env.js";

/**
 * Idempotency map: SharePoint source id → the Outline doc it became. Its own
 * table (created on boot) so the ingest service stays decoupled from the
 * assistant's Drizzle migrations, in the same Postgres.
 */
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

export async function initStore(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sharepoint_imports (
      source_id text PRIMARY KEY,
      outline_document_id text NOT NULL,
      title text,
      content_hash text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export type ImportRecord = {
  sourceId: string;
  outlineDocumentId: string;
  contentHash: string | null;
};

export async function getImport(sourceId: string): Promise<ImportRecord | null> {
  const { rows } = await pool.query(
    `SELECT source_id, outline_document_id, content_hash FROM sharepoint_imports WHERE source_id = $1`,
    [sourceId],
  );
  if (rows.length === 0) return null;
  return {
    sourceId: rows[0].source_id,
    outlineDocumentId: rows[0].outline_document_id,
    contentHash: rows[0].content_hash,
  };
}

export async function upsertImport(rec: {
  sourceId: string;
  outlineDocumentId: string;
  title: string;
  contentHash: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO sharepoint_imports (source_id, outline_document_id, title, content_hash, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (source_id) DO UPDATE SET
       outline_document_id = EXCLUDED.outline_document_id,
       title = EXCLUDED.title,
       content_hash = EXCLUDED.content_hash,
       updated_at = now()`,
    [rec.sourceId, rec.outlineDocumentId, rec.title, rec.contentHash],
  );
}

export function hashContent(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
