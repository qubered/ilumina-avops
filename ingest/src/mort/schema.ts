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

    -- Runtime settings (e.g. authoring mode) — overrides env defaults, editable
    -- from the admin UI without a redeploy.
    CREATE TABLE IF NOT EXISTS mort_settings (
      key        text PRIMARY KEY,
      value      text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- Transient store for a proposed ATTACH's original bytes, so the file can be
    -- uploaded when the proposal is approved. Deleted once attached or rejected.
    CREATE TABLE IF NOT EXISTS mort_blobs (
      source_id    text PRIMARY KEY,
      file_name    text NOT NULL,
      content_type text NOT NULL,
      data         bytea NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now()
    );

    -- Episodic memory (R1): one row per action logged in the events spreadsheet.
    -- One row ≠ one KB page — these are dated observations, not documentation.
    CREATE TABLE IF NOT EXISTS mort_events (
      id           bigserial PRIMARY KEY,
      source_id    text NOT NULL,
      row_hash     text NOT NULL,
      event        text,
      occurred_on  date,
      zone         text[] NOT NULL DEFAULT '{}',
      system       text[] NOT NULL DEFAULT '{}',
      entities     text[] NOT NULL DEFAULT '{}',
      action_text  text NOT NULL,
      ingested_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_id, row_hash)
    );

    -- Current-state facts (R1 slice 3). The ONLY thing that may override a
    -- documented KB procedure as "what is true now" — and only because a human
    -- approved it. Event-log rows are observations; these are decisions.
    CREATE TABLE IF NOT EXISTS mort_facts (
      id             bigserial PRIMARY KEY,
      fact_key       text NOT NULL,
      value          text NOT NULL,
      scope          text,
      effective_from date,
      effective_to   date,
      source_tier    text,
      approved_by    text NOT NULL,
      confidence     text,
      supersedes     bigint,
      note           text,
      created_at     timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS mort_rel_by_doc ON mort_source_doc_relations (mort_id);
    CREATE INDEX IF NOT EXISTS mort_events_source ON mort_events (source_id);
    CREATE INDEX IF NOT EXISTS mort_events_date ON mort_events (occurred_on);
    CREATE INDEX IF NOT EXISTS mort_facts_key ON mort_facts (fact_key);
    CREATE INDEX IF NOT EXISTS mort_review_pending ON mort_review_queue (status) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS mort_journal_source ON mort_journal (source_id);
  `);
}
