# ILUMINA AV Ops Assistant

AI assistant for the ILUMINA venue AV crew (Harry The Hirer Productions). Answers operational questions **only** from the crew's Outline wiki knowledge base, with citations back to the exact source page. Runs beside the wiki, matches its look, and embeds into Outline pages as a chat widget.

- **Chat** — streaming answers with a `kb_search` tool loop (Vercel AI SDK), plus provider-executed **web search** for general equipment/manufacturer info (`AI_WEB_SEARCH`, KB stays the only authority for venue-specific facts). Scope-guarded: the assistant declines anything that isn't venue AV/event ops and resists in-conversation override attempts. Citations render as typed source rows (wiki doc vs web link), answers render markdown tables, and **images/files embedded in wiki docs render inline** (attachment URLs are rewritten at sync time to a session-gated proxy that fetches from Outline with the bot key). Multi-turn history, auto-titles.
- **Accounts** — email + password via Better Auth, optionally gated by a crew invite code (`SIGNUP_KEY`; empty = open registration). First registered user becomes admin. **This app is also the OIDC identity provider for Outline** — crew log into the wiki with the same account (see [Outline SSO](#outline-sso-this-app-as-identity-provider)).
- **KB sync** — full sync from Outline's API (published, non-template, non-archived docs only), instant re-index via HMAC-verified webhooks, nightly 04:00 Australia/Sydney cron backstop.
- **Admin** — sync status, per-doc errors, re-sync button, feedback review, KB-gap candidates.
- **Widget** — `widget.js` injects a chat bubble into Outline via nginx `sub_filter`; the panel iframes `/widget` (CSP `frame-ancestors`, cross-subdomain cookies).

## Stack

Next.js 16 (App Router, TypeScript, Turbopack) · Vercel AI SDK v7 + `@ai-sdk/anthropic` (`claude-sonnet-5`) · Voyage `voyage-3-large` embeddings (1024d) · Qdrant · Postgres + Drizzle ORM · Better Auth (+ OIDC provider plugin) · Tailwind CSS v4 · Vitest · Docker.

## Repository layout

```
avops-assistant/          this app
  src/lib/rag/            chunker, embeddings, Qdrant store, sync, agent
  src/lib/outline.ts      Outline POST-RPC API client
  src/lib/auth.ts         Better Auth config (incl. OIDC provider for Outline)
  src/proxy.ts            CSP frame-ancestors for /widget (Next 16 "proxy", ex-middleware)
  scripts/seed.ts         seed Qdrant from ../sample_kb
  docker/                 nginx.conf + postgres init script
  drizzle/                SQL migrations (applied automatically at boot)
../sample_kb/             three demo KB docs (repo root)
```

## Local development

> Setting up on a fresh machine? Follow **[DEV_SETUP.md](DEV_SETUP.md)** — the step-by-step including the optional local Outline + SSO environment.

```bash
cd avops-assistant
cp .env.example .env               # fill it in (see below)
docker run -d -p 5432:5432 -e POSTGRES_USER=avops -e POSTGRES_PASSWORD=avops -e POSTGRES_DB=avops postgres:16
docker run -d -p 6333:6333 qdrant/qdrant
pnpm install
pnpm dev                           # migrations run automatically at boot
```

For local dev set `DATABASE_URL=postgres://avops:avops@localhost:5432/avops`, `QDRANT_URL=http://localhost:6333`, `APP_URL=http://localhost:3000`, and leave `COOKIE_DOMAIN` empty. `OUTLINE_URL`/`OUTLINE_API_KEY`/`OUTLINE_WEBHOOK_SECRET` must be non-empty (use placeholders if you're only demoing with the seed data).

**Demo without a live Outline:** `pnpm seed` loads the three docs from `../sample_kb` straight into Qdrant (and the admin page's doc list if Postgres is up). The three starter questions in the empty chat state are answerable from them.

```bash
pnpm test                          # Vitest: chunker, metadata parser, webhook verifier, doc filtering
pnpm db:generate                   # regenerate migrations after schema changes
```

## Production (docker-compose + Cloudflare Tunnel)

`docker-compose.yml` runs the full stack: `outline-postgres` (one instance, two databases via init script), `outline-redis`, `outline`, `qdrant`, `assistant` (this app), `nginx` (widget-injection layer for Outline only), and `cloudflared` (public access).

Public access is via a **Cloudflare Tunnel** — outbound-only, no ports exposed on the box, TLS terminated at Cloudflare's edge:

1. Zero Trust → Networks → Tunnels → create a tunnel, put its token in `.env` (`TUNNEL_TOKEN`).
2. Add two public hostnames on the tunnel:
   - `kb.venue.example` → `http://nginx:80` (Outline, with the widget script injected)
   - `assistant.venue.example` → `http://assistant:3000`
3. Update the `sub_filter` URL in `docker/nginx.conf` to your assistant hostname.

```bash
cp .env.example .env               # fill everything in
docker compose up -d --build
```

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

nginx rewrites every Outline HTML response to load the embed script:

```nginx
location / {
  proxy_pass http://outline:3000;
  sub_filter '</body>' '<script src="https://assistant.venue.example/widget.js" defer></script></body>';
  sub_filter_once on;
  proxy_set_header Accept-Encoding "";   # sub_filter needs uncompressed HTML
}
```

`widget.js` (served by this app, no dependencies, everything namespaced `avops-*`) adds a floating bubble that toggles a 380×560 iframe pointed at `/widget` — the compact chat UI backed by the user's single rolling widget conversation. `/widget` sends `Content-Security-Policy: frame-ancestors 'self' {OUTLINE_URL}` instead of `X-Frame-Options: DENY`.

## AI providers — including Codex (ChatGPT subscription) auth

`AI_PROVIDER` selects the chat backend (`src/lib/rag/model.ts`, pattern taken from `qubered/health-tracker`):

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

Caveats for codex mode: it's the **unofficial ChatGPT backend** — outside OpenAI's intended use, may break without notice, and the whole crew shares one subscription's rate limits. Embeddings are not covered by any of this: `VOYAGE_API_KEY` is always required. For a business deployment the API-key providers are the safe options.

## How answers are produced

1. **Sync** — Outline docs (markdown) are fetched via the POST-RPC API. An optional leading metadata block (`Zone:` / `System:` / `Type:`, comma-splittable, case-insensitive) is parsed into Qdrant payload fields and stripped from the indexed body.
2. **Chunking** — heading-aware splitting on `#`–`####` (code fences ignored), ~500-token target, oversized sections split on paragraph boundaries with a ~60-token tail overlap, tiny adjacent chunks merged. Every chunk starts with a `[Doc title › Heading › Subheading]` breadcrumb so it's self-describing.
3. **Retrieval** — Voyage embeddings (`input_type` document/query), cosine search in the `ilumina_kb` Qdrant collection, top 5.
4. **Agent** — `streamText` with a `kb_search` tool and up to 6 steps; the system prompt (brief §7, verbatim) forbids answering outside the KB and requires a Sources list. Sources are collected from the tool results actually used, deduped, persisted with the message, and rendered as chips.

The agent definition (`src/lib/rag/agent.ts`) is plain server-side code with no HTTP coupling, so a later Slack bot can import it directly.

## Decisions & deviations (boring-option notes)

- **The brief's reference material was missing.** The repo contained no `ilumina_rag/`, `DESIGN.md`, or `sample_kb/` — everything was built from the brief's own spec (§6.2 fully defines the chunker; §7 the prompt). The three `sample_kb/` docs were authored fresh as demo content; the "port the Python test cases" instruction became fresh Vitest suites covering the behaviors the brief names.
- **Better Auth instead of Auth.js** (requested mid-build), which also enables the OIDC-provider role. Auth routes live at `/api/auth/[...all]` rather than the brief's `[...nextauth]`, and register/login rate limiting uses Better Auth's built-in in-memory limiter. Better Auth owns the `user` table (text ids); app tables reference it.
- **OIDC provider plugin**: Better Auth 1.6 deprecates `oidcProvider` in favour of `@better-auth/oauth-provider`. v1 intentionally uses `oidcProvider` because it supports inline trusted clients + `skipConsent` from env without a JWKS/JWT setup; migrate when adopting Better Auth 2.x.
- **Next 16**: `middleware.ts` is renamed `proxy.ts`; page `params` are async; the widget CSP header is set in the proxy at request time (Outline URL is runtime env).
- **Widget conversation**: one extra schema column vs the brief (`conversations.is_widget`) implements the "single rolling widget conversation".
- **Migrations at boot**: the container applies Drizzle migrations in `instrumentation.ts` (no separate migration runner); env is zod-validated there too, so a misconfigured container fails fast with a readable error.
- **Feedback ids**: streamed messages swap to their DB-persisted form (real ids + canonical sources) via a refetch when the stream finishes; thumbs appear then.
- **"Unanswered questions"** on the admin page is a heuristic (assistant replies containing "does not cover" etc.) plus the thumbs-down list — good enough for KB-gap review in v1.
- **Sync locking** is a per-process flag (single container). If you scale out, move it to a DB lock.
