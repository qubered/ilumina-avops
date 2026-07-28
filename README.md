# ILUMINA AV Ops

AI assistant for the ILUMINA venue AV crew — answers operational questions from the crew's Outline wiki with citations — and fixes the wiki back, from the same conversation, behind a confirm-then-live card — doubles as the OIDC identity provider for Outline, and embeds into wiki pages as a chat widget. "Mort" is the same agent on both sides: chat and the SharePoint→Outline ingestion pipeline share one brain (`packages/mort-core`) — see `MORT_V2_PLAN.md`.

This is a pnpm workspace — run `pnpm install` once at the repo root, not inside an individual app.

- **[apps/assistant/](apps/assistant/)** — the chat app (Next.js 16, AI SDK, Better Auth, Qdrant, Drizzle). Full docs, setup, and deploy instructions in its [README](apps/assistant/README.md).
- **[apps/ingest/](apps/ingest/)** — SharePoint → Outline ingestion service. Power Automate POSTs base64 files; Mort decides how the KB should change. See its [README](apps/ingest/README.md).
- **[packages/mort-core/](packages/mort-core/)** — the shared brain both apps import directly (identity, model selection, memory/KB stores, the Outline client, the agent loop) — no HTTP boundary between them.
- **[watcher/](watcher/)** — the Python watcher that runs on the OneDrive machine and POSTs file changes to `apps/ingest`.
- **[docker/](docker/)** — the full Docker Compose stack (Outline + assistant + ingest + Postgres + Redis + Qdrant + Ollama + nginx + cloudflared).
- **[sample_kb/](sample_kb/)** — three demo KB docs used to seed/demo without a live wiki.
