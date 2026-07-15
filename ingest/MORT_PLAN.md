# Mort — the ILUMINA AV God

**A documentation agent for the ILUMINA AV Ops KB.** One identity, two faces: the
**authoring face** (the ingest service maintains the KB) and the **conversational
face** (the assistant chat answers from it). Soul in the margins, facts stay neutral.

This is the **canonical spec**, rewritten after two review passes (a full CEO/Design/
Eng/DX auto-review, then a second dual-voice eng+strategy review). Earlier drafts
accreted into a multi-system "v1"; per both reviews and Jayden's approval, v1 is now
cut to a **defensible authoring core**, with everything else on an explicit roadmap.
Full history is in the Appendix — nothing is lost, just sequenced.

---

## Part I — Vision & grounding

### Mort
Mort understands each incoming file, places it intelligently in the KB (not one page
per file), keeps documentation current, and never damages curated knowledge. His
personality ("the ILUMINA AV God" — dry, competent, reverent about the craft) flavours
the *margins* (journal, footers, review rationales, later chat voice) but **never the
facts**: KB article bodies and answer facts stay neutral, cited, and safety-first.

### Locked premises (confirmed)
| # | Decision | Choice |
|---|----------|--------|
| Trigger | How Mort runs | Event-driven per-file POST from a **OneDrive + Python watcher**; cross-file awareness via memory. |
| Autonomy | Power over curated docs | Autonomous but **never destructive**; structural/overwrite/delete → review queue. |
| Home | Where Mort lives | Authoring agent in `ingest/`; retrieval agent stays in the assistant. Shared over an **HTTP boundary** + a tiny dependency-free `mort-identity` module. No monorepo. |
| Memory | Store | Postgres. Corpus/decision memory in v1; episodic + conventions later. |

### What exists today
- **`ingest/`** — stateless Hono service. `POST /ingest` → [`extract.ts`](src/extract.ts)
  → [`normalise.ts`](src/normalise.ts) (one `generateObject`) → [`outline.ts`](src/outline.ts)
  create/update one doc + attach. Idempotency: `sharepoint_imports(source_id → doc, hash)`.
  Publishes live, one file = one article. The watcher
  ([`watcher/folder_watcher.py`](watcher/folder_watcher.py)) polls a folder, sends stable
  files, and **moves them to `_processed/`**.
- **`avops-assistant/`** — Next.js RAG chat. Owns embeddings, Qdrant
  ([`rag/store.ts`](../avops-assistant/src/lib/rag/store.ts)), chunker, model, and a
  **retrieval** agent ([`rag/agent.ts`](../avops-assistant/src/lib/rag/agent.ts)) with a
  `kb_search` tool. Docs carry `Zone:/System:/Type:` metadata
  ([`rag/metadata.ts`](../avops-assistant/src/lib/rag/metadata.ts)).
- **Not a monorepo** — the three dirs are siblings.

---

## Part II — v1 spec (the defensible cut)

v1 = the **authoring core**, safe and shippable. Each piece below is required for a
correct, non-destructive first release. Deferred features are in Part III.

### v1.1 — Ingestion: fail-closed OneDrive watcher
The watch folder **is the live OneDrive-synced folder**, so the watcher must be safe
against sync states, and must not reorganise the crew's SharePoint.

- **Rewrite to a state-tracking, no-move watcher** backed by a local **SQLite manifest**:
  `files(rel_path PK, size, mtime_ns, file_id, checksum, hydrated, last_sent_at, status)`.
  Leave files in place (never move — a move syncs back to the cloud).
- **Cheap-signal diff:** compute checksum only when `(size, mtime_ns)` changed **and the
  file is locally hydrated**. Never sha256 the whole corpus every scan.
- **OneDrive Files-On-Demand:** skip non-hydrated placeholders (check reparse /
  `OFFLINE` / `RECALL_ON_DATA_ACCESS` attributes) — reading their bytes force-downloads
  or corrupts. Never send a placeholder.
- **Quarantine:** conflict copies (`… (conflicted copy)`, `…-DESKTOP-xxxx`), Office lock
  files, zero-byte, partial/`.tmp` — skip, don't send (they create duplicate docs).
- **Deletion = FAIL CLOSED (v1).** A file missing locally is **tombstoned + queued for
  review**, never auto-purged — OneDrive offline/selective-sync/unmount routinely makes
  present files look deleted. **Hard-halt** the delete path entirely if: the folder root
  is missing/empty, sync reports in-progress, or file count drops below a **stable
  baseline** (not a per-scan delta). Auto-delete returns later via Graph delta (Part III).
- **Rename** = same checksum, new path → emit a **`move` op** (server rebinds the source),
  not delete+create — avoids orphaned attachments/relations/review-queue spam.
- `POST /ingest` **enqueues and returns `202`**; a worker runs the Mort turn (throughput
  on bulk load; the 300s client timeout otherwise fits a turn).

### v1.2 — Identity model (Postgres)
Split source identity from document identity so semantic reuse and renames are safe:
- `mort_sources(source_id = rel_path PK, checksum, role, folder_origin, tombstoned_at, …)`
- `mort_docs(mort_id PK, outline_doc_id, collection, title, folder_origin, …)`
- `mort_source_doc_relations(source_id, doc_id, relation ∈ {authored, attached, updated})`
- **Doc registry** unique key for dedup: `(folder_origin, system, normalised_title)`. v1
  uses **folder-mirror placement** — a file's path is its home — so path is a strong,
  stable dedup anchor. (Semantic re-homing is Part III.)

### v1.3 — The decision core (single structured call, shadow-mode first)
Per file, **not** a multi-step agent loop:
1. `extract` (reuse) → **file-role classify**: `truth` (Word/procedures), `structured`
   (patch sheets/xlsx), `reference` (show/binary — attach, don't transcribe), `media`.
2. `kb_search` (HTTP, v1.5) → `kb_get_doc` on the top candidate.
3. **One structured decision** `{action, target, confidence, rationale}` where action ∈
   `CREATE · UPDATE_ADDITIVE · ATTACH · REVIEW · SKIP`.
- **Confidence gate on every write** — below threshold → review queue, even a CREATE
  (the real risk is additive-but-*misfiled*, not deletion).
- **Shadow / propose-only bootstrap**: the first corpus load (and first N turns) sends
  *all* actions to the review queue until the golden-decision eval passes; then promote.
- **Source-of-truth hierarchy** (Appendix A) decides which input wins on conflict; Word
  docs are ground truth, reference files attach rather than transcribe.

### v1.4 — Safe writes (VERIFY the mechanism first)
- **STEP 0, before building:** empirically round-trip a doc with a comment marker + a
  table + `Key: value` lines through `documents.update` → `documents.info` and diff the
  returned `text`. Outline's ProseMirror likely **drops HTML comments and normalises
  whitespace**. If markers don't survive, delimit Mort's region with a **real heading**
  (`## Mort — maintained section`) and a sentinel; splice by heading and re-serialize.
  Byte-equality outside the region is impossible (ProseMirror normalises) → the
  guarantee is **structural (heading boundaries)**, not textual.
- Mort writes **only inside his region**; human content outside is untouched. Structural
  edits / overwrites / deletes → review.
- **Per-`target_doc_id` AND per-`source_id` advisory locks** + **revision CAS** (re-read
  the Outline revision id immediately before write; if changed, re-run the merge). Async
  workers break the watcher's serial ordering, so locking is required.
- **Dedicated "Mort" Outline identity** (own user + least-privilege token) so
  `updatedBy ≠ mort` ⇒ human edit (curated-doc detection) and every write is attributable.

### v1.5 — Retrieval boundary (no monorepo)
- Assistant exposes **`POST /api/internal/kb-search`** (returns the existing
  `KbSearchResult[]` shape) and **`/api/internal/kb-get-doc`**, both behind a **signed
  internal token / mTLS**. Mort calls over HTTP.
- The only shared *source* is a **dependency-free `mort-identity`** module (persona,
  scope fence, safety + citation rules) both services load. Never share `model.ts`.

### v1.6 — Memory (v1 subset) & metadata
- Tables: the identity trio (v1.2) + `mort_journal` (action, target, rationale,
  confidence, model, **token/step/cost counters**), `mort_doc_state(doc_id,
  last_mort_revision_id, last_mort_body_hash, last_mort_ts)`, `mort_review_queue`
  (status, **dedupe key** `(target_doc_id, action, payload_hash)`, tombstones).
- **Metadata stays minimal in v1** — keep today's `Zone/System/Type`. The rich in-doc
  header + parser rewrite is deferred (Part III) so it lands with its backfill.

### v1.7 — Ops, security, migration (all part of v1)
- **Worker rails:** job ids, idempotency keys, retry + **dead-letter queue**, poison-file
  handling, **per-file/day model-spend cap**, structured logs, and alerts on delete
  spikes, write spikes, low-confidence rate, sync failure, and Qdrant drift.
- **Security:** signed internal tokens or mTLS on every ingest↔assistant call,
  per-endpoint scopes, least-privilege Mort Outline identity, audit logs on writes/deletes.
- **Migration/backfill:** existing Outline docs + Qdrant points get registry ids,
  **deterministic point ids**, and (when rich metadata lands) `updatedAt` payload;
  schema-versioned; a one-time reindex command; gate any new retrieval behind migration.

### v1.8 — Tests (gate the build)
- **Watcher harness** over fake filesystem states: placeholder/online-only, conflict copy,
  offline/unmounted, partial download, rename, mass-delete threshold — must **fail closed**.
- **Golden decision set:** sample files (Word procedure, patch xlsx, show file, photo) →
  expected action + target doc.
- **Marker/heading round-trip test** (v1.4 STEP 0) and a **never-destructive property
  test** (human content preserved).

### v1 phasing
- **P1 — foundation:** watcher rewrite (v1.1) + identity model (v1.2) + HTTP boundary
  (v1.5) + safe-write mechanism verified (v1.4) + memory tables (v1.6) + ops/security
  scaffold (v1.7). Ships behind shadow mode.
- **P2 — authoring live:** decision core (v1.3) promoted from shadow, review-queue admin
  tab, migration/backfill (v1.7), tests green (v1.8).

---

## Part III — Roadmap (deferred, sequenced, with rationale)

Each was designed in earlier drafts (preserved in the Appendix) and deferred to keep v1
safe and shippable. Order is a recommendation.

- **R1 — Episodic memory + current-state model.** The events spreadsheet ("Ran SDI…",
  "Raised LED wall to 2.5m") ingests row-by-row (`mort_events`, per-row idempotency,
  row-set reconciliation) into a **separate Qdrant collection** (not the KB collection —
  event points lack `title/url` and would break citations + dilute results). Answering is
  **present-both**: KB = documented standard, event = dated observation, "verify" — never
  auto-resolved by timestamp. A **typed current-state model** (`facts(fact_key, value,
  scope, effective_from, effective_to, source_tier, approved_by, confidence, supersedes)`)
  is the *only* thing that can override a KB procedure as "current." Replaces the discarded
  most-recent-wins rule.
- **R2 — Chat persona + memory.** Light-flavor Mort voice (facts stay terse/cited;
  suppressed on safety-critical steps) via the shared identity module; read-only
  `mort_memory` + `event_log` tools (chat reads Mort's Postgres directly; shared DB).
- **R3 — Rich metadata.** Extended in-doc header (ProseMirror-safe `Key: value`) +
  `metadata.ts` parser rewrite (parse a known key-set in any order; terminate at first
  blank line after a known key) + chunker payload + `updatedAt` stamping — **landed
  together with backfill** so nothing de-indexes.
- **R4 — Semantic placement.** Move from folder-mirror to Mort re-homing docs by meaning
  (structural moves via review), once the identity model is proven in production.
- **R5 — Whole-file auto-delete.** Via **Microsoft Graph delta / eTag** (authoritative),
  not local absence; two-phase tombstone → confirmed-delete. Replaces v1's review-only.
- **R6 — Agent loop + conventions.** Promote the single decision call to a bounded
  multi-step loop only where the golden eval shows single-pass fails; learned conventions
  gated on decay/precedence/caps + an edit UI.

---

## Part IV — Appendix

### A. Source-of-truth hierarchy
1. **Word documents** — ground truth. 2. **Structured exports** (patch sheets) —
authoritative for their narrow facts (patches, IPs, VLANs). 3. **Reference/show files**
(MA3, console shows) — attach + summarise, never transcribe as prose. 4. **Media** —
illustration. Lower tiers never override a Word doc; conflicts are flagged. Safety-critical
topics (mains, rigging, work-at-height) always defer to the KB procedure + flag.

### B. Worked example — MA3 show file (v1 behaviour)
`ILUMINA_MainStage_v4.show.gz` → role `reference` → `kb_search` finds "Main Stage —
Lighting" → decision `ATTACH` under a Show-files section + `UPDATE_ADDITIVE` a version row
(v4 supersedes v3), inside Mort's region → journal it. **Not** a new page named after the
file. (If no confident target exists yet, → review, not a speculative page.)

### C. Superseded assumptions (why they were dropped)
- **Byte-for-byte non-destructive marker** → ProseMirror drops comments/normalises text;
  replaced with heading-boundary structural guard (v1.4), pending the STEP-0 test.
- **Most-recent-wins** → `updatedAt` is polluted by Mort's own edits and compares specs vs
  one-off actions; replaced with present-both + current-state model (R1).
- **Semantic placement in v1** → conflicts with path-identity/dedup; folder-mirror in v1,
  semantic in R4.
- **Whole-file auto-delete in v1** → unsafe from a live OneDrive folder; tombstone+review
  in v1, Graph-delta auto-delete in R5.
- **Ingest mutating Qdrant** → two-writer race; assistant is single Qdrant owner via an
  outbox/sync reconcile.

### D. Decision audit trail
All decisions from both review passes, most recent first. (Earlier per-section audit
tables are consolidated here.)

| # | Area | Decision | Class |
|---|------|----------|-------|
| G1 | Scope | Cut v1 to authoring core; defer event log/retrieval, chat, rich metadata, semantic placement, delete execution | User (gate) |
| G2 | Retrieval | Drop most-recent-wins → present-both + typed current-state model (R1) | User (gate) |
| G3 | Deletion | v1 = tombstone + review; auto-delete via Graph delta later (R5) | User (gate) |
| G4 | Placement | v1 = folder-mirror; semantic later (R4) | Corrected (both voices) |
| E1 | Safety | Verify marker survival first; else heading-boundary region | Auto (F1) |
| E2 | Identity | Split source/doc identity + relations | Auto (both voices) |
| E3 | Qdrant | Assistant single-owner via outbox; ingest writes Postgres only | Auto (both voices) |
| E4 | Retrieval | Events in a separate Qdrant collection (protect `kb_search` citations) | Auto (F5) |
| E5 | Watcher | Placeholder-skip, conflict-copy quarantine, cheap-signal hashing, fail-closed deletes, `move` op for rename | Auto (both voices) |
| E6 | Concurrency | Per-`source_id` + per-doc locks + revision CAS | Auto (F13) |
| E7 | Platform | Add ops rails, security boundaries, migration/backfill, watcher test matrix | Auto (both voices) |
| E8 | Metadata | Parser rewrite + rich header land together w/ backfill (R3); minimal in v1 | Auto (F2) |
| — | (prior) | Premises (trigger/autonomy/home/memory), unified Mort, event-log design, OneDrive+SQLite watcher, folder-lineage metadata | See git history of this file |

### E. Review provenance
- Pass 1: `/autoplan` — CEO + Eng dual voices (Codex + Claude subagent). Reversals: UC1
  (reconciliation), UC2 (lean core), UC3 (HTTP boundary).
- Pass 2: full dual-voice eng review — found the three unverified assumptions (marker,
  live-folder-as-truth, recency), scope creep, and the missing ops/security/migration/test
  layers. Drove the reset above.
