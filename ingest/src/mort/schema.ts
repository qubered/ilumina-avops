import { pool } from "./db.js";

/**
 * Mort's memory model (v1). Created on boot, idempotently. Splits SOURCE
 * identity (files) from DOCUMENT identity (KB pages) with typed relations
 * between them — so a renamed/deleted file touches only its own relation, never
 * the semantic doc it fed. See MORT_PLAN.md §v1.2 / §v1.6.
 */
export async function initMortSchema(): Promise<void> {
  await pool.query(`
    -- Corpus map: every source file Mort knows about. source_id = watcher rel path.
    CREATE TABLE IF NOT EXISTS mort_sources (
      source_id     text PRIMARY KEY,
      checksum      text,
      role          text NOT NULL DEFAULT 'unknown',
      folder_origin text,
      status        text NOT NULL DEFAULT 'active',   -- active | tombstoned
      summary       text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );

    -- KB documents Mort maintains. mort_id = Mort's canonical slug.
    CREATE TABLE IF NOT EXISTS mort_docs (
      mort_id              text PRIMARY KEY,
      outline_document_id  text NOT NULL,
      collection           text,
      title                text NOT NULL,
      folder_origin        text,
      system               text,
      registry_key         text NOT NULL UNIQUE,   -- dedup: (folder_origin|system|norm title)
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    );

    -- Typed source→doc relations (many-to-many).
    CREATE TABLE IF NOT EXISTS mort_source_doc_relations (
      source_id text NOT NULL,
      mort_id   text NOT NULL,
      relation  text NOT NULL,   -- authored | attached | updated
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source_id, mort_id, relation)
    );

    -- Decision journal (what Mort did + why + what it cost).
    CREATE TABLE IF NOT EXISTS mort_journal (
      id         bigserial PRIMARY KEY,
      ts         timestamptz NOT NULL DEFAULT now(),
      source_id  text,
      mort_id    text,
      action     text NOT NULL,
      rationale  text,
      confidence real,
      model      text,
      tokens     integer,
      cost_usd   numeric(10,4),
      conflicts  jsonb
    );

    -- Per-doc write state: curated-doc detection + revision CAS.
    CREATE TABLE IF NOT EXISTS mort_doc_state (
      outline_document_id  text PRIMARY KEY,
      last_mort_revision_id text,
      last_mort_body_hash   text,
      last_mort_ts          timestamptz NOT NULL DEFAULT now()
    );

    -- Human review queue. dedupe_key makes re-proposals idempotent.
    CREATE TABLE IF NOT EXISTS mort_review_queue (
      id           bigserial PRIMARY KEY,
      action       text NOT NULL,
      source_id    text,
      mort_id      text,
      target_doc_id text,
      payload      jsonb,
      rationale    text,
      dedupe_key   text NOT NULL UNIQUE,
      status       text NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
      created_at   timestamptz NOT NULL DEFAULT now(),
      decided_at   timestamptz,
      decided_by   text
    );

    CREATE INDEX IF NOT EXISTS mort_rel_by_doc ON mort_source_doc_relations (mort_id);
    CREATE INDEX IF NOT EXISTS mort_review_pending ON mort_review_queue (status) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS mort_journal_source ON mort_journal (source_id);
  `);
}
