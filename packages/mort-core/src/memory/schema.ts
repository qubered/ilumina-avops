import { pool } from "./db";

/**
 * Mort's memory model (v1). Created on boot, idempotently. Splits SOURCE
 * identity (files) from DOCUMENT identity (KB pages) with typed relations
 * between them — so a renamed/deleted file touches only its own relation, never
 * the semantic doc it fed. See MORT_PLAN.md §v1.2 / §v1.6.
 */
export async function ensureMortSchema(): Promise<void> {
  await pool.query(`
    -- Corpus map: every source file Mort knows about. source_id = watcher rel path.
    -- The library: every file Mort has been given, what he understood it to be,
    -- and what it's about — whether or not it ever becomes an article.
    CREATE TABLE IF NOT EXISTS mort_sources (
      source_id     text PRIMARY KEY,
      checksum      text,
      role          text NOT NULL DEFAULT 'unknown',
      folder_origin text,
      status        text NOT NULL DEFAULT 'active',   -- active | tombstoned
      summary       text,
      zone          text[] NOT NULL DEFAULT '{}',
      system        text[] NOT NULL DEFAULT '{}',
      entities      text[] NOT NULL DEFAULT '{}',
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
    -- Additive for tables created before the library gained understanding.
    ALTER TABLE mort_sources ADD COLUMN IF NOT EXISTS zone     text[] NOT NULL DEFAULT '{}';
    ALTER TABLE mort_sources ADD COLUMN IF NOT EXISTS system   text[] NOT NULL DEFAULT '{}';
    ALTER TABLE mort_sources ADD COLUMN IF NOT EXISTS entities text[] NOT NULL DEFAULT '{}';

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

    -- Decision journal (what Mort did + why + what it cost). mort_id and
    -- outline_document_id are separate columns (a journal entry names EITHER
    -- a real mort_id or an Outline document id, never both) — see the
    -- backfill below for the historical rows that conflated the two.
    CREATE TABLE IF NOT EXISTS mort_journal (
      id                   bigserial PRIMARY KEY,
      ts                   timestamptz NOT NULL DEFAULT now(),
      source_id            text,
      mort_id              text,
      outline_document_id  text,
      action               text NOT NULL,
      rationale            text,
      confidence real,
      model      text,
      tokens     integer,
      cost_usd   numeric(10,4),
      conflicts  jsonb
    );
    ALTER TABLE mort_journal ADD COLUMN IF NOT EXISTS outline_document_id text;

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

    -- Durable job queue (v1.7 ops rails). Jobs carry their bytes so a turn
    -- survives a restart; retried with backoff and dead-lettered after N attempts
    -- rather than lost silently. Live mode writes autonomously, so nothing here
    -- may depend on the process staying up.
    CREATE TABLE IF NOT EXISTS mort_jobs (
      id           bigserial PRIMARY KEY,
      source_id    text NOT NULL,
      file_name    text NOT NULL,
      content_type text NOT NULL,
      folder_path  text,
      content_hash text NOT NULL,
      data         bytea NOT NULL,
      status       text NOT NULL DEFAULT 'pending',  -- pending | running | dead
      -- Re-check this file even if its content is unchanged: a page it might
      -- belong on has just appeared.
      force        boolean NOT NULL DEFAULT false,
      attempts     integer NOT NULL DEFAULT 0,
      last_error   text,
      run_after    timestamptz NOT NULL DEFAULT now(),
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    -- Idempotent enqueue: one live job per (source, content version).
    CREATE UNIQUE INDEX IF NOT EXISTS mort_jobs_live_uniq
      ON mort_jobs (source_id, content_hash) WHERE status IN ('pending', 'running');
    CREATE INDEX IF NOT EXISTS mort_jobs_claim ON mort_jobs (status, run_after);
    ALTER TABLE mort_jobs ADD COLUMN IF NOT EXISTS force boolean NOT NULL DEFAULT false;

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

    -- Confirm-then-live queue (v2 P1). A write tool NEVER writes: it parks the
    -- payload here with the preview the user was shown, and the write happens
    -- only when a session-authenticated human confirms it. The model can
    -- propose; it cannot commit. Rows expire (MORT_PENDING_TTL_HOURS) so an
    -- ignored card is a no-op rather than a landmine.
    CREATE TABLE IF NOT EXISTS mort_pending_actions (
      id              uuid PRIMARY KEY,
      conversation_id uuid,
      user_id         text NOT NULL,          -- who Mort was talking to
      tool            text NOT NULL,          -- save_fact | retire_fact | log_event
      payload         jsonb NOT NULL,
      preview         text,                   -- what was shown for confirmation
      status          text NOT NULL DEFAULT 'pending',  -- pending|confirmed|cancelled|expired
      created_at      timestamptz NOT NULL DEFAULT now(),
      decided_at      timestamptz,
      decided_by      text,                   -- session-derived, never model-supplied
      result          jsonb                   -- what the executor did, for the audit trail
    );
    CREATE INDEX IF NOT EXISTS mort_pending_open ON mort_pending_actions (created_at) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS mort_pending_by_convo ON mort_pending_actions (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS mort_pending_by_user ON mort_pending_actions (user_id, created_at);

    CREATE INDEX IF NOT EXISTS mort_rel_by_doc ON mort_source_doc_relations (mort_id);
    CREATE INDEX IF NOT EXISTS mort_events_source ON mort_events (source_id);
    CREATE INDEX IF NOT EXISTS mort_events_date ON mort_events (occurred_on);
    CREATE INDEX IF NOT EXISTS mort_facts_key ON mort_facts (fact_key);
    CREATE INDEX IF NOT EXISTS mort_review_pending ON mort_review_queue (status) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS mort_journal_source ON mort_journal (source_id);
  `);

  await backfillSemanticRegistryKeys();
  await backfillJournalOutlineIds();
}

/**
 * R4 migration: registry identity became SEMANTIC (system|title). Legacy keys
 * embedded folder_origin, so once identity dropped the folder a doc whose file
 * moved would no longer match and Mort would create a duplicate. Recompute the
 * legacy keys into the new form.
 *
 * Idempotent (already-correct rows are skipped). If two docs collapse onto one
 * key the UNIQUE constraint rejects the update — logged, not fatal: that's a
 * genuine duplicate pair for a human to merge, and the old keys keep working
 * until they do.
 */
async function backfillSemanticRegistryKeys(): Promise<void> {
  const NEW_KEY = `lower(regexp_replace(btrim(coalesce(system, '')), '\\s+', ' ', 'g')) || '|' ||
                   lower(regexp_replace(btrim(title), '\\s+', ' ', 'g'))`;
  try {
    const { rowCount } = await pool.query(
      `UPDATE mort_docs d SET registry_key = k.new_key
         FROM (SELECT mort_id, ${NEW_KEY} AS new_key FROM mort_docs) k
        WHERE d.mort_id = k.mort_id AND d.registry_key IS DISTINCT FROM k.new_key`,
    );
    if (rowCount) console.log(`[mort] migrated ${rowCount} registry key(s) to semantic identity`);
  } catch (err) {
    console.warn(
      "[mort] registry-key backfill skipped — two docs likely share one semantic key now; merge the duplicates manually:",
      err,
    );
  }
}

/**
 * v2 migration: `mort_journal.mort_id` was never consistently a mort_id — every
 * call site that set it actually passed an Outline document id (createDoc's
 * return value, or decision.targetDocId, both Outline ids). Move those
 * historical values into the new outline_document_id column instead of
 * leaving readers to guess with an ambiguous OR-join.
 *
 * Only touches rows that are UNAMBIGUOUSLY the outline-id case: mort_id
 * matches some doc's outline_document_id, and does NOT also happen to match a
 * real mort_id (collisions are astronomically unlikely — mort_id is a
 * slug+hash, outline_document_id is a UUID — but left alone and logged rather
 * than guessed at). Idempotent: already-migrated rows have mort_id NULL and
 * no longer match the WHERE clause.
 */
async function backfillJournalOutlineIds(): Promise<void> {
  try {
    const { rowCount } = await pool.query(
      `UPDATE mort_journal j SET outline_document_id = j.mort_id, mort_id = NULL
         FROM mort_docs d
        WHERE d.outline_document_id = j.mort_id
          AND NOT EXISTS (SELECT 1 FROM mort_docs d2 WHERE d2.mort_id = j.mort_id)`,
    );
    if (rowCount) console.log(`[mort] migrated ${rowCount} journal row(s) from mort_id to outline_document_id`);
  } catch (err) {
    console.warn("[mort] journal outline-id backfill skipped:", err);
  }
}
