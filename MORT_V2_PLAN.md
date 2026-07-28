# MORT v2 — One Mort

Status: design locked 2026-07-27. Supersedes the Part III roadmap in `ingest/MORT_PLAN.md`
(R1–R7). That document remains the v1 record; this one is the v2 spec. Feature work is
tracked as GitHub issues (see Part V for the issue map).

---

## Part 0 — What v2 is

v1 built two Morts that share a name and a persona:

- **Chat Mort** (`avops-assistant`): a bounded agent loop with four *read-only* tools
  (`kb_search`, `event_log`, `mort_memory`, `current_state`). He can find things out but
  cannot change anything. Talking to him is one-way — he answers, he never learns.
- **Authoring Mort** (`ingest`): a fixed three-pass pipeline (understand → gather → decide)
  that files OneDrive documents into Outline. He changes things but you can't talk to him;
  his only human interface is the admin review queue.

v2 collapses this into **one Mort**: a single agent runtime with a single tool belt —
read *and* write — one memory, one identity, one journal. Chat becomes the whole UI:
you tell Mort things and he remembers them with provenance ("Jayden told me the LED wall
is at 6m on 23 July"), corrects his own pages, logs what happened, and reflects on his
own decisions to get better over time. Ingestion becomes just another way a turn starts.

### Locked premises

| # | Decision | Rationale |
|---|---|---|
| V2-1 | Chat-taught facts are **confirm-then-live**: Mort restates his understanding, the user confirms in-chat, the fact is saved immediately — attributed, journaled, reversible. No admin queue for facts. | Killing the two-engine feel means the person in the chat *is* the approver. `mort_facts.approved_by` semantics are preserved: a named human still approves every fact — the approval just happens in the conversation. |
| V2-2 | Chat write scope is **full**: facts, event-log entries, KB doc edits, and new KB pages. Doc writes reuse the v1 safe-write machinery (mort regions, doc locks, revision CAS, review fallback). | The safe-write layer was built exactly so writes could be widened without widening blast radius. |
| V2-3 | **Monorepo, one brain.** pnpm workspace with a shared `mort-core` package (identity, models, memory stores, tools, agent loop) consumed by the chat app and the ingest worker. One agent runtime, two entry points. | Ends the duplicated model selectors, the persona-over-HTTP fetch, and the kb-search HTTP shuttle. Reverses v1's "deliberately not a monorepo" premise — that premise existed to ship v1 fast, and it did. |
| V2-4 | Self-learning follows the **reflection pattern** (not a specific external codebase): capture outcome signals → distill lessons in a nightly reflection → inject active lessons into future prompts → let humans view/retire lessons. Built on the existing journal + dream job. | Mort already has the raw material: `mort_journal` (every decision with rationale/confidence), `mort_review_queue` decisions (approve/reject = ground truth), and the chat `feedback` table (thumbs + comments) that currently feeds nothing. |
| V2-5 | Every tool call — chat or ingest, local or MCP — is journaled. Tools carry **policy tiers** enforced by the harness, not the prompt. | An agent that can write needs an audit trail and a permission model that survives prompt injection. |
| V2-6 | The v1 write guardrails survive unchanged: shadow/live mode, confidence gates, review queue for low-confidence/invented-target actions, daily token cap, bounded steps. | v2 widens what Mort *can* do, not what he can do *unsupervised*. |

---

## Part I — Architecture

### I.1 Monorepo layout

```
ilumina-avops/
  package.json            # pnpm workspace root
  pnpm-workspace.yaml
  packages/
    mort-core/            # THE brain — no HTTP server, no Next.js
      src/
        identity/         # persona, voices, scope, safety (hoisted from ingest/src/mort/identity.ts)
        model/            # ONE provider selector (merges src/lib/rag/model.ts + ingest/src/mort/model.ts)
        memory/           # facts, events, journal, lessons — store APIs over Postgres
        kb/               # chunker, embeddings, Qdrant stores, Outline client, safe writes (regions/locks/CAS)
        tools/            # the unified tool belt + registry + policy tiers
        agent/            # the loop: runTurn(entry, context) with step cap, spend rail, journaling
        mcp/              # MCP client manager (connect, discover, namespace, gate)
  apps/
    assistant/            # the Next.js app (moved from avops-assistant/), imports mort-core
    ingest/               # the Hono worker (moved from ingest/), imports mort-core
  watcher/                # Python watcher (moved from ingest/watcher/) — unchanged, still plain HTTP
  sample_kb/
  docker/                 # compose + init scripts (hoisted from avops-assistant/)
```

Rules:

- `mort-core` owns all Postgres access to `mort_*` tables and all Qdrant access. The
  Drizzle schema moves into core and absorbs the hand-written SQL from `ingest/src/mort/schema.ts`.
- The assistant keeps ownership of its own tables (conversations, messages, feedback,
  auth) but reads/writes Mort state only through core APIs.
- The internal HTTP boundary (`/api/internal/kb-search`, `/api/internal/index-events`,
  `GET /mort/identity|memory|facts`) is **deleted** — both apps call core directly.
  The never-built `/api/internal/kb-get-doc` (MORT_PLAN §v1.5) dies un-built; core's
  `kb.getDocument()` is the sanctioned path.
- The watcher's external contract (`POST /ingest`, `POST /ingest/delete`, API key auth)
  is unchanged — zero changes on the OneDrive machine.
- Docker services stay as they are (assistant + ingest remain separate containers);
  they just build from workspace packages now.

### I.2 One agent loop

`mort-core/agent` exposes a single entry point:

```ts
runTurn(entry: TurnEntry, ctx: TurnContext): Promise<TurnResult>

type TurnEntry =
  | { kind: "chat";   messages: ModelMessage[]; user: ActingUser }
  | { kind: "ingest"; job: IngestJob }                       // file arrived from watcher
  | { kind: "dream" }                                        // nightly reflection

type TurnContext = {
  channel: "chat" | "ingest" | "dream";
  actor: ActingUser | "system";     // attribution source — NEVER model-supplied
  conversationId?: string;
  toolPolicy: ToolPolicy;           // which tiers are enabled for this turn
  spend: SpendRail;                 // shared daily token cap
}
```

- Chat turns stream (the assistant wraps `runTurn` in the existing resumable-stream
  plumbing). Ingest and dream turns run non-streaming inside the job worker.
- The v1 authoring pipeline (classify → understand → gather → decide) is **promoted into
  the loop** (this is v1's deferred R6): `classify` stays deterministic pre-processing;
  understand/gather/decide become the agent reasoning with the same tools chat uses
  (`kb_search`, `kb_get_doc`, `mort_memory`, plus the write tools). The v1 guards move
  from `turn.ts` into the tool layer, where they now protect chat too:
  invented `targetDocId` → forced review; shadow mode → all KB writes become proposals;
  confidence below threshold → review queue.
- `MAX_STEPS` stays bounded but becomes per-channel config (chat 6 → 10; ingest 12;
  dream 8) in `mort_settings`.

### I.3 The unified tool belt

Every tool declares a **policy tier**; the harness enforces tiers per turn and journals
every invocation (name, args hash, actor, channel, conversation, outcome, latency).

| Tier | Meaning | Tools |
|---|---|---|
| `read` | No side effects | `kb_search`, `kb_get_doc`, `event_log_search`, `mort_memory`, `current_state`, `list_pending`, `web_search` (provider) |
| `write:memory` | Mort's own state — cheap to reverse | `save_fact`, `retire_fact`, `log_event`, `note_lesson` |
| `write:kb` | Outline pages — mort-region safe writes | `propose_doc_edit`, `apply_doc_edit`, `create_doc`, `attach_source` |
| `write:world` | Anything beyond Mort's systems | all MCP-provided tools (default; per-tool override possible) |
| `admin` | Operator actions | `decide_review`, `set_mode`, `mcp_toggle` |

Tier policy by channel and role:

- **chat / member**: `read` + `write:memory` (confirm-first) + `propose_doc_edit` only
  (proposals land in the review queue).
- **chat / admin**: everything except `write:world`; `write:world` tools additionally
  require per-call confirmation.
- **ingest**: `read` + `write:kb` under the existing shadow/confidence gates. No
  `write:world`, no `write:memory` for facts (ingest never invents facts — v1 premise:
  facts require a named human).
- **dream**: `read` + `note_lesson` + `propose_doc_edit` (housekeeping proposals only).

### I.4 Confirm-then-live mechanics (V2-1)

The model never commits a write on its own say-so; attribution never comes from the model.

1. Mort calls `save_fact` (or `log_event` / `apply_doc_edit` / `create_doc`) with the
   payload. The tool does **not** write — it creates a row in `mort_pending_actions`
   and returns `{ pendingId, preview }`.
2. The assistant renders the tool part as a **confirmation card** (fact card, event card,
   or doc diff) with Confirm / Edit / Cancel.
3. Confirm hits `POST /api/mort/actions/[id]/confirm`. The route takes the acting user
   from the session (never the request body — same rule as v1 `approvedBy`), re-checks
   role + tier policy, then hands the payload to the core executor which performs the
   write, journals it, and appends a system-visible result into the conversation.
4. A plain-text "yes" also works: the agent calls `confirm_pending` with the pendingId;
   the harness only honors it when the pending action belongs to this conversation *and*
   the current session user — and the executor still stamps attribution from the session.
5. Pending actions expire (default 24h) and are visible via `list_pending` and the admin UI.

`mort_pending_actions`:

```sql
CREATE TABLE mort_pending_actions (
  id              uuid PRIMARY KEY,
  conversation_id uuid,
  user_id         text NOT NULL,          -- who Mort was talking to
  tool            text NOT NULL,          -- save_fact | log_event | apply_doc_edit | create_doc | ...
  payload         jsonb NOT NULL,
  preview         text,                   -- what was shown for confirmation
  status          text NOT NULL DEFAULT 'pending',  -- pending|confirmed|cancelled|expired
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);
```

### I.5 MCP harness

- `mort-core/mcp`: an MCP **client** manager using the AI SDK's MCP client. Servers are
  registered in a new table, loaded at boot, reconnected with backoff, and their tools
  merged into the belt namespaced `mcp__<server>__<tool>`.

```sql
CREATE TABLE mort_mcp_servers (
  name          text PRIMARY KEY,
  transport     text NOT NULL,            -- stdio | sse | streamable-http
  config        jsonb NOT NULL,           -- url/command/env (secrets via env refs, not literals)
  enabled       boolean NOT NULL DEFAULT false,
  default_tier  text NOT NULL DEFAULT 'write:world',
  tool_overrides jsonb NOT NULL DEFAULT '{}',   -- { "<tool>": {"tier": "read", "enabled": false} }
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

- All MCP tools are confirm-first at `write:world` until an admin explicitly downgrades a
  specific tool (e.g. a read-only status endpoint → `read`).
- Admin UI page + chat admin commands to list servers, toggle, and test-call.
- This is the runway for "Mort controls stuff": when a lighting console / PDU / DAW
  exposes an MCP server, registering it is config, not code.

### I.6 Reflection & lessons (V2-4)

**Signals** (all already captured or one join away):

1. `mort_journal` — every decision with rationale, confidence, action, cost.
2. `mort_review_queue` decisions — approved vs rejected proposals: ground-truth grading
   of Mort's judgment.
3. `feedback` — thumbs + comments on chat answers (currently written, never read).
4. **Corrections** — a new first-class signal: when a user contradicts Mort in chat
   ("no, that's wrong, it's actually X"), the agent calls `log_event`/`save_fact` as
   appropriate *and* the turn is tagged `corrected` in the journal.

**Distillation** — the nightly dream (existing job) gains a reflection phase:

- Read the last N days of signals; ask: where was I wrong, what pattern explains it,
  what should I do differently. Output structured lessons.
- Lessons write to `mort_lessons` with evidence links back to the journal/feedback rows
  that produced them. Lessons are **active immediately** but fully visible and retirable
  (same philosophy as confirm-then-live: transparent and reversible beats gated).

```sql
CREATE TABLE mort_lessons (
  id          uuid PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  lesson      text NOT NULL,              -- one imperative sentence
  detail      text,                       -- optional elaboration
  scope       text[] NOT NULL DEFAULT '{}',  -- chat | ingest | zone/system tags
  evidence    jsonb NOT NULL DEFAULT '[]',   -- [{kind: 'journal'|'feedback'|'review', id: ...}]
  origin      text NOT NULL,              -- dream | human
  status      text NOT NULL DEFAULT 'active',  -- active | retired
  retired_by  text,
  retired_at  timestamptz
);
```

**Injection**: `buildSystemPrompt` gains a `LESSONS` section — top N active lessons
filtered by channel scope, most recent first, hard cap (~10, ~800 tokens). Prompt
structure: persona → voice → lessons → system rules, so lessons can tune behavior but
never override safety/scope rules (which come last and are framed as overriding).

**Visibility**: "what have you learned lately?" in chat (a `read` tool over
`mort_lessons`), an admin lessons panel with retire buttons, and each lesson traceable
to its evidence.

Deliberately **not** in v2: online prompt self-editing, per-turn self-critique passes,
auto-finetuning. The loop is: experience → nightly distillation → visible lessons →
human-retirable. Boring, auditable, effective.

### I.7 Provenance model

Every piece of taught knowledge answers "who, when, where":

- `mort_facts` gains `taught_via` (`chat|admin`), `conversation_id`, `message_id`.
  The existing `supersedes` column (never wired in v1) is finally written: updating a
  fact inserts a new row superseding the old, giving full history. `approved_by` keeps
  its meaning.
- `mort_events` gains `reported_by`, `conversation_id`. Chat-taught events use
  `source_id = 'chat:<conversationId>'` with `row_hash = sha256(normalized content)`,
  so they flow through the existing reconcile/index machinery untouched.
- `mort_journal` gains `actor` (user id or `system`), `channel` (`chat|ingest|dream`),
  and `conversation_id`; the v1 `mort_id`-sometimes-holds-an-outline-id inconsistency
  is migrated to explicit `mort_id` + `outline_document_id` columns.

So "how do you know that?" is answerable, verbatim, from data:
*"Jayden told me the LED wall is at 6m — 23 July, in chat"* with a link to the message.

---

## Part II — Chat as the whole UI

The chat surface grows from Q&A into Mort's front door. Admin pages remain as the
power-user fallback, but everything routine happens in conversation.

- **Teaching**: fact/event confirmation cards (I.4) with inline edit before confirm.
- **Doc changes**: `propose_doc_edit` renders a proper diff of the mort region
  (before/after), with Apply / Review-queue / Cancel for admins, Send-to-review for members.
- **Brain dump**: paste (or dictate) a wall of unstructured info — "here's everything
  about the new comms setup" — and Mort structures it using the same machinery ingestion
  uses: understand → gather to find existing pages (prefer `UPDATE_ADDITIVE` over
  creating duplicates — the v1 rule), then split the remainder into properly formatted
  new pages following KB conventions (title, collection, headings, breadcrumbs, metadata
  facets). Output is one confirmation card per page (diff card for updates, preview card
  for new pages), each confirm-then-live individually. Provenance records the dump's
  conversation as the source (`chat:<conversationId>`), and new pages register in
  `mort_docs` with semantic registry keys so ingestion and chat keep one registry.
  Fact-shaped and event-shaped statements found inside a dump are offered as facts/events
  (I.4), not buried in prose — one dump can fan out into pages *and* memory.
- **Provenance chips**: facts and events cited in answers carry "who told me, when"
  chips linking to the source conversation or file.
- **Admin in chat**: admins can ask "what's pending?" and approve/reject review-queue
  items via `decide_review` with the same card pattern; "go to shadow mode" via `set_mode`.
- **Digest**: "what's changed this week?" — a `read` tool over journal + lessons +
  facts producing a dated change summary. Same renderer as the admin activity panel.
- **Widget parity**: the compact widget gets read + teach (facts/events); doc-edit
  cards are full-app only.

History context stays at 20 messages for now; durable context lives in facts, which is
the point — "remember X until told otherwise" is a fact, not a longer chat buffer.

---

## Part III — What this fixes from v1 (known seams)

| v1 seam | v2 resolution |
|---|---|
| Two model selectors (`src/lib/rag/model.ts` + `ingest/src/mort/model.ts`) | One in `mort-core/model` (Codex token-rotation quirks included, used by whoever configures it) |
| Persona fetched over HTTP, cached process-wide forever | Direct import from core; cache invalidation problem deleted |
| `identity.ts` hoist noted in v1 but never done | Done — `mort-core/identity` |
| `kb-get-doc` boundary specified, never built; ingest reads Outline directly | Boundary deleted; `kb.getDocument()` in core is the one path |
| `mort_journal.mort_id` ambiguity | Explicit columns + backfill migration |
| `mort_facts.supersedes` never wired | Wired; fact updates create superseding rows |
| `DecisionAction` type missing `HOLD` | Types regenerated from the Zod schemas in core |
| `feedback` written but never read | Reflection signal (I.6) |
| Per-process sync lock breaks if scaled | Postgres advisory lock in core `kb/sync` |

---

## Part IV — Guardrails, ops, security

- **Spend**: the daily token cap now covers all channels (chat writes included) via the
  shared `SpendRail`; per-channel soft budgets reported in `/mort/health`.
- **Rate limits**: per-user cap on pending-action creation (default 30/day) so a
  runaway conversation can't flood the queue.
- **Mode**: `mort_settings.mode` extends to chat KB writes — `shadow` turns
  `apply_doc_edit`/`create_doc` into review-queue proposals even for admins. Facts and
  events (write:memory) stay live in shadow — they're Mort's own reversible state.
- **Injection posture**: tool tiers and attribution are enforced in route handlers and
  the executor, never by prompt. Document content ingested from OneDrive is untrusted;
  it can never trigger `write:memory`/`write:world` because ingest-channel policy
  excludes those tiers entirely.
- **Audit**: journal covers every tool call (V2-5). The admin activity panel and the
  chat digest read the same journal.
- **Kill switches**: global mode `off` still stops ingestion; new `chat_writes: off`
  setting freezes all chat-originated writes without touching Q&A.

---

## Part V — Phasing & issue map

Each phase ships independently and leaves the system working.

| Phase | Feature | Depends on |
|---|---|---|
| P0 | Monorepo restructure + `mort-core` extraction (no behavior change) | — |
| P1 | Teach Mort: facts & events from chat, confirm-then-live, pending actions | P0 |
| P2 | Provenance: schema additions, supersedes, chips, "how do you know" | P1 |
| P3 | Doc edits & new pages from chat (diff cards, safe writes, review fallback) | P1 |
| P4 | Tool harness: registry, policy tiers, universal journaling | P0 |
| P5 | MCP client: server registry, discovery, gating, admin UI | P4 |
| P6 | One loop for ingestion (v1's R6): pipeline → agent turn | P0, P4 |
| P7 | Reflection & lessons: signals, dream distillation, injection, visibility | P4 |
| P8 | Chat-as-UI polish: admin in chat, digest, widget parity | P1–P3 |

P4 can proceed in parallel with P1–P3 (it formalizes what P1 builds ad hoc; land P4
before P5/P6/P7).
