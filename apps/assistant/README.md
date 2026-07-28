# ILUMINA AV Ops Assistant

AI assistant for the ILUMINA venue AV crew (Harry The Hirer Productions). Answers operational questions **only** from the crew's Outline wiki knowledge base, with citations back to the exact source page. Runs beside the wiki, matches its look, and embeds into Outline pages as a chat widget.

- **Chat** — streaming answers with a `kb_search` tool loop (Vercel AI SDK), plus provider-executed **web search** for general equipment/manufacturer info (`AI_WEB_SEARCH`, KB stays the only authority for venue-specific facts). Scope-guarded: the assistant declines anything that isn't venue AV/event ops and resists in-conversation override attempts. Citations render as typed source rows (wiki doc vs web link), answers render markdown tables, and **images/files embedded in wiki docs render inline** (attachment URLs are rewritten at sync time to a session-gated proxy that fetches from Outline with the bot key). Multi-turn history, auto-titles. In-flight answers survive tab close and **resume streaming live on return** (Redis-backed via `resumable-stream`; without `REDIS_URL` it degrades to poll-on-return — answers are never lost either way).
- **Accounts** — email + password via Better Auth, optionally gated by a crew invite code (`SIGNUP_KEY`; empty = open registration). First registered user becomes admin. **This app is also the OIDC identity provider for Outline** — crew log into the wiki with the same account (see [Outline SSO](#outline-sso-this-app-as-identity-provider)).
- **KB sync** — full sync from Outline's API (published, non-template, non-archived docs only), instant re-index via HMAC-verified webhooks, nightly 04:00 Australia/Sydney cron backstop.
- **Admin** — sync status, per-doc errors, re-sync button, feedback review, KB-gap candidates.
- **Widget** — `widget.js` injects a chat bubble into Outline via nginx `sub_filter`; the panel iframes `/widget` (CSP `frame-ancestors`, cross-subdomain cookies).
- **SharePoint ingestion** — a separate `ingest` service (see [`../ingest`](../ingest)) takes base64 files from a Power Automate flow, AI-normalises each into a KB article with attachments, and publishes into Outline (indexed automatically via the webhook). Both apps share one brain, `packages/mort-core` — no HTTP boundary between them.

## Stack

Next.js 16 (App Router, TypeScript, Turbopack) · Vercel AI SDK v7 + `@ai-sdk/anthropic` (`claude-sonnet-5`) · local Ollama embeddings (`nomic-embed-text` default; Voyage API optional) · Qdrant · Postgres + Drizzle ORM · Better Auth (+ OIDC provider plugin) · Tailwind CSS v4 · Vitest · Docker · pnpm workspace.

## Repository layout

This app is one package in a pnpm workspace rooted one level up — `pnpm install` runs at the repo root, not here.

```
apps/assistant/            this app
  src/lib/auth.ts           Better Auth config (incl. OIDC provider for Outline)
  src/proxy.ts               CSP frame-ancestors for /widget (Next 16 "proxy", ex-middleware)
  scripts/seed.ts             seed Qdrant from ../../sample_kb
  drizzle/                     SQL migrations (applied automatically at boot)
../../packages/mort-core/  shared: identity, model selection, chunker/embeddings/Qdrant
                            store, Outline client, agent loop, memory stores — imported
                            directly by this app AND apps/ingest, no HTTP between them
../../docker/               compose stack, nginx.conf template, postgres init script
../../sample_kb/            three demo KB docs
```

## Local development

> Setting up on a fresh machine? Follow **[DEV_SETUP.md](DEV_SETUP.md)** — the step-by-step including the optional local Outline + SSO environment.

```bash
cd ilumina-avops                   # repo root
pnpm install                       # installs the whole workspace
cd apps/assistant
cp .env.example .env               # fill it in (see below)
docker run -d -p 5432:5432 -e POSTGRES_USER=avops -e POSTGRES_PASSWORD=avops -e POSTGRES_DB=avops postgres:16
docker run -d -p 6333:6333 qdrant/qdrant
pnpm dev                           # migrations run automatically at boot
```

For local dev set `DATABASE_URL=postgres://avops:avops@localhost:5432/avops`, `QDRANT_URL=http://localhost:6333`, `APP_URL=http://localhost:3000`, and leave `COOKIE_DOMAIN` empty. `OUTLINE_URL`/`OUTLINE_API_KEY`/`OUTLINE_WEBHOOK_SECRET` must be non-empty (use placeholders if you're only demoing with the seed data).

**Demo without a live Outline:** `pnpm seed` loads the three docs from `../sample_kb` straight into Qdrant (and the admin page's doc list if Postgres is up). The three starter questions in the empty chat state are answerable from them.

```bash
pnpm test                          # Vitest: chunker, metadata parser, webhook verifier, doc filtering
pnpm db:generate                   # regenerate migrations after schema changes
```

## Production (docker-compose + Cloudflare Tunnel)

`docker/docker-compose.yml` (repo root) runs the full stack: `outline-postgres` (one instance, two databases via init script), `outline-redis`, `outline`, `ollama`, `qdrant`, `assistant` (this app), `ingest`, `nginx` (widget-injection layer for Outline only), and `cloudflared` (public access). Both Dockerfiles build from the repo root (pnpm workspace context) — see `docker/docker-compose.yml`'s `build:` blocks.

Public access is via a **Cloudflare Tunnel** — outbound-only, no ports exposed on the box, TLS terminated at Cloudflare's edge:

1. Zero Trust → Networks → Tunnels → create a tunnel, put its token in `.env` (`TUNNEL_TOKEN`).
2. Add two public hostnames on the tunnel:
   - `kb.venue.example` → `http://nginx:80` (Outline, with the widget script injected)
   - `assistant.venue.example` → `http://assistant:3000`

The widget-injection nginx renders its config from `../../docker/nginx.conf.template`
at startup, filling the script URL from `APP_URL` — nothing to hand-edit.

```bash
cd docker                          # repo root docker/
cp .env.example .env               # fill everything in
docker compose up -d --build
```

**Hardware**: the full stack runs in ~2.5&nbsp;GB RAM and needs no GPU — the
embedding model (`nomic-embed-text`, 137M params) is CPU-friendly and kept
resident by `OLLAMA_KEEP_ALIVE=-1`. On an older CPU expect sub-second query
embeddings and full syncs in minutes (they run nightly). The first
`--build` compiles the Next.js app on the box and is the slowest step
(one-time per deploy, ~5–15&nbsp;min on older hardware); build remotely and
push an image if that ever grates.

Both apps share a parent domain (`COOKIE_DOMAIN=.venue.example`) so the widget iframe inside Outline is authenticated. Because both hostnames are real public HTTPS URLs, all server-side cross-calls just use them: Outline's OIDC `token`/`userinfo` requests and its webhook delivery go through the tunnel — no `ALLOWED_PRIVATE_IP_ADDRESSES` / SSRF configuration needed (that's only a local-dev concern, see `docker/dev-outline.sh`). Chat streaming (SSE) passes through Cloudflare fine since tokens flow continuously; the assistant returns `202` immediately for long syncs, so nothing brushes against Cloudflare's ~100s idle limit.

### First run

1. Open the assistant, register — the **first account becomes admin**.
2. In Outline, create a dedicated bot account, then an API key (Settings → API) → `OUTLINE_API_KEY`.
3. In Outline, add a webhook (Settings → Webhooks): URL `https://assistant.venue.example/api/webhooks/outline`, subscribe to document events, set a signing secret → `OUTLINE_WEBHOOK_SECRET`.
4. Admin page → **Re-sync now** to index the wiki. Publishing a doc in Outline is the "crew-ready" gate — drafts, templates, and archived docs are never indexed.

### Outline SSO (this app as identity provider)

Better Auth's OIDC provider plugin exposes standard endpoints under `/api/auth/oauth2/*`. Outline is registered as a trusted client (no consent screen) from env:

1. Generate credentials once: `OIDC_CLIENT_ID=$(openssl rand -hex 16)`, `OIDC_CLIENT_SECRET=$(openssl rand -hex 32)` — set them in `.env` (compose passes them to **both** containers).
2. Outline is configured via `OIDC_AUTH_URI`/`OIDC_TOKEN_URI`/`OIDC_USERINFO_URI` pointing at the assistant (already wired in `docker-compose.yml`), with `OIDC_USERNAME_CLAIM=email`.
3. Crew flow: click "AV Ops SSO" on Outline's login screen → redirected to this app's login (or straight through if already signed in) → back into Outline. One account everywhere; register in this app first.

### Widget injection into Outline

The `nginx` service ([`../../docker/nginx.conf.template`](../../docker/nginx.conf.template)) proxies Outline and rewrites every HTML response to load the embed script (`${APP_URL}` filled in at startup):

```nginx
sub_filter '</body>' '<script src="${APP_URL}/widget.js" defer></script></body>';
sub_filter_once on;
proxy_set_header Accept-Encoding "";      # sub_filter needs uncompressed HTML
proxy_hide_header Content-Security-Policy; # Outline's CSP would block the cross-origin script + iframe
```

`widget.js` (served by this app, no dependencies, everything namespaced `avops-*`) adds a floating bubble that toggles a 380×560 iframe pointed at `/widget` — the compact chat UI backed by the user's single rolling widget conversation. `/widget` sends `Content-Security-Policy: frame-ancestors 'self' {OUTLINE_URL}` so Outline can embed it.

**Why drop Outline's CSP?** Outline sends a strict `Content-Security-Policy` whose `script-src`/`frame-src` don't include the assistant origin, so without this the injected script and iframe are silently blocked by the browser. Dropping it at the proxy is the pragmatic fix for an internal, authenticated wiki; if you'd rather keep Outline's CSP, replace the `proxy_hide_header` line with a rewritten policy that adds `${APP_URL}` to `script-src` and `frame-src`.

## AI providers — including Codex (ChatGPT subscription) auth

`AI_PROVIDER` selects the chat backend (`packages/mort-core/src/model/chat.ts`, pattern taken from `qubered/health-tracker`):

| Value | What it uses | Needs |
|---|---|---|
| `anthropic` (default) | Anthropic API, `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI Responses API (or any compatible endpoint via `OPENAI_BASE_URL`) | `OPENAI_API_KEY` |
| `codex` | The Codex CLI's ChatGPT Plus/Pro login — the token from `codex login` sent straight to the Codex backend | `~/.codex/auth.json` (no API key) |

**Codex mode** reads `auth.json` fresh on every request; with `CODEX_AUTO_REFRESH=true` an expiring token is refreshed via the official OAuth refresh flow and the rotated tokens are **written back to `auth.json`** (atomic tmp+rename), the same way the codex CLI does. That write-back is mandatory, not cosmetic: OpenAI refresh tokens are single-use, so an unpersisted refresh burns the stored token and breaks both the app and the CLI login (`"refresh token was already used"` → re-run `codex login`). In Docker, run `codex login` on the host and mount `~/.codex` **read-write** (see the commented volume on the `assistant` service).

Codex backend quirks (all handled inside `model.ts`, live-verified including the `kb_search`-style tool loop):

- **Streaming only** — non-streaming calls 400, so everything (including title generation) uses `streamText`.
- **`store: false` is mandatory** (`"Store must be set to false"`); injected via model middleware so no call site can forget it.
- **Standard sampling/limit params are rejected** (`"Unsupported parameter: max_output_tokens"`); middleware strips `maxOutputTokens`/`temperature`/`topP`/penalties in codex mode.
- The system prompt travels as the Responses API top-level `instructions` field (`systemPromptOptions()` picks the right shape per provider).

Caveats for codex mode: it's the **unofficial ChatGPT backend** — outside OpenAI's intended use, may break without notice, and the whole crew shares one subscription's rate limits. Embeddings aren't covered by any of this either — the default local Ollama embeddings keep the stack subscription-only. For a business deployment the API-key chat providers are the safe options.

## How answers are produced

1. **Sync** — Outline docs (markdown) are fetched via the POST-RPC API. An optional leading metadata block (`Zone:` / `System:` / `Type:`, comma-splittable, case-insensitive) is parsed into Qdrant payload fields and stripped from the indexed body.
2. **Chunking** — heading-aware splitting on `#`–`####` (code fences ignored), ~500-token target, oversized sections split on paragraph boundaries with a ~60-token tail overlap, tiny adjacent chunks merged. Every chunk starts with a `[Doc title › Heading › Subheading]` breadcrumb so it's self-describing.
3. **Retrieval** — Voyage embeddings (`input_type` document/query), cosine search in the `ilumina_kb` Qdrant collection, top 5.
4. **Agent** — `streamText` with a `kb_search` tool and up to `max_steps_chat` (10) steps; the system prompt (brief §7, verbatim) forbids answering outside the KB and requires a Sources list. Sources are collected from the tool results actually used, deduped, persisted with the message, and rendered as chips. The belt itself comes from the tool harness below.

## Fixing the wiki from chat

Mort's chat tool belt is read **and** write (`MORT_V2_PLAN.md` §I.3–I.4). "That patching page is wrong, it's actually X" gets you a before/after diff of Mort's section of the page and a Confirm button; pasting a wall of notes gets you one card per page, fact and event the dump contains.

The rules that make that safe are enforced in code, never in the prompt:

- **No tool writes.** A write tool parks its payload in `mort_pending_actions` and returns a preview. The write happens in `POST /api/mort/actions/[id]/confirm`, run by a named human, with attribution taken from that human's **session** — never from the request body, never from the model.
- **Mort only edits his own region.** Every doc write goes through the v1 safe-write machinery (`<!-- mort:start -->` markers, per-doc locks, revision CAS, human-edit detection). Human content outside the markers is preserved byte-for-byte, a page Mort has never touched gets a region appended rather than rewritten, and a page with a *malformed* region is never auto-spliced — it goes to review.
- **Policy tiers, resolved server-side** (`packages/mort-core/src/tools/`): crew members can only propose (→ admin review queue); `shadow` mode turns every chat KB write into a proposal, admins included; a low-confidence edit, or one aimed at a doc id the model never actually found in a search result, goes to review.
- **Kill switch**: admin page → *Chat writes: Frozen* stops every chat-originated write without touching questions and answers. Per-user cap of 30 proposals a day.
- Applied edits re-index immediately, so the change is searchable in the next answer, and every one is journaled into the admin activity panel.

## The tool harness

One registry, one policy, one audit trail (`MORT_V2_PLAN.md` §I.2–I.3, decision V2-5). Every tool Mort has is declared once in `packages/mort-core/src/tools/registry.ts` with its **policy tier** — `read`, `write:memory`, `write:kb`, `write:world`, `admin` — and `tools/policy.ts` says which tiers exist on which channel, for which role.

- **A turn is `runTurn(entry, ctx)`** (`packages/mort-core/src/agent/run-turn.ts`). The channel (`chat` / `ingest` / `dream`) and the actor are properties of the turn, and the belt follows from them *before* any prompt exists — so what Mort can do is never a function of what the turn says. Chat streams, so the route uses `prepareTurn` and drives `streamText` itself; the plan is identical either way.
- **Injection posture**: a document arriving from OneDrive is processed on the `ingest` channel, which has no `write:memory` tier at all. It cannot teach Mort a fact however it phrases itself — not because the prompt says so, but because the tool isn't there. If one reaches a belt by some other route, the harness refuses it at call time and logs the attempt.
- **Every call is journaled** to `mort_tool_calls`: tool, tier, actor, channel, conversation, an args *hash*, outcome (`ok` / `error` / `refused`) and latency. Refusals sort to the top of the admin tool log. This is a different artifact from `mort_journal`, which stays the decision journal — why a page is the way it is, a handful of rows a day.
- **One spend rail**: the daily token cap covers every channel, not just ingestion (`mort_spend`). Chat is metered but never blocked by it — cutting a crew member off mid-bump-in because the nightly dream was expensive is the worse failure. Per-channel soft budgets and step caps live in `mort_settings` (`max_steps_chat` 10, `max_steps_ingest` 12, `max_steps_dream` 8) and show in the admin health panel.

`brain_dump` handles the paste-a-wall-of-notes case: it splits the dump into pages, facts and events, then runs the *same* understand→gather machinery ingestion uses to find the existing page first — extending it beats creating a near-duplicate. New pages register in `mort_docs` under the same semantic registry key ingestion uses, so chat and ingestion maintain one registry, not two.

A dump's fact- and event-shaped statements come out as `save_fact` / `log_event` cards (the P1 teaching flow) rather than being buried in a page's prose — one dump fans out into pages *and* memory. A `Send to review` button on any wiki card hands it to an admin instead of applying it, which stays available even when applying doesn't (e.g. the mode flipped to shadow while the card sat there).


The agent definition (`packages/mort-core/src/agent/index.ts`) is plain server-side code with no HTTP coupling, so a later Slack bot can import it directly.

## Decisions & deviations (boring-option notes)

- **The brief's reference material was missing.** The repo contained no `ilumina_rag/`, `DESIGN.md`, or `sample_kb/` — everything was built from the brief's own spec (§6.2 fully defines the chunker; §7 the prompt). The three `sample_kb/` docs were authored fresh as demo content; the "port the Python test cases" instruction became fresh Vitest suites covering the behaviors the brief names.
- **Better Auth instead of Auth.js** (requested mid-build), which also enables the OIDC-provider role. Auth routes live at `/api/auth/[...all]` rather than the brief's `[...nextauth]`, and register/login rate limiting uses Better Auth's built-in in-memory limiter. Better Auth owns the `user` table (text ids); app tables reference it.
- **OIDC provider plugin**: Better Auth 1.6 deprecates `oidcProvider` in favour of `@better-auth/oauth-provider`. v1 intentionally uses `oidcProvider` because it supports inline trusted clients + `skipConsent` from env without a JWKS/JWT setup; migrate when adopting Better Auth 2.x.
- **Next 16**: `middleware.ts` is renamed `proxy.ts`; page `params` are async; the widget CSP header is set in the proxy at request time (Outline URL is runtime env).
- **Widget conversation**: one extra schema column vs the brief (`conversations.is_widget`) implements the "single rolling widget conversation".
- **Migrations at boot**: the container applies Drizzle migrations in `instrumentation.ts` (no separate migration runner); env is zod-validated there too, so a misconfigured container fails fast with a readable error.
- **Feedback ids**: streamed messages swap to their DB-persisted form (real ids + canonical sources) via a refetch when the stream finishes; thumbs appear then.
- **"Unanswered questions"** on the admin page is a heuristic (assistant replies containing "does not cover" etc.) plus the thumbs-down list — good enough for KB-gap review in v1.
- **Sync locking** is a Postgres advisory lock (`packages/mort-core/src/kb/sync-lock.ts`), so it's correct across multiple replicas, not just one process.
