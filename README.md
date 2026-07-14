# ILUMINA AV Ops

AI assistant for the ILUMINA venue AV crew — answers operational questions from the crew's Outline wiki with citations, doubles as the OIDC identity provider for Outline, and embeds into wiki pages as a chat widget.

- **[avops-assistant/](avops-assistant/)** — the app (Next.js 16, AI SDK, Better Auth, Qdrant, Drizzle). Full docs, setup, and deploy instructions in its [README](avops-assistant/README.md). The Docker compose stack lives here.
- **[ingest/](ingest/)** — SharePoint → Outline ingestion service. Power Automate POSTs base64 files; it AI-normalises each into a KB article. See its [README](ingest/README.md).
- **[sample_kb/](sample_kb/)** — three demo KB docs used to seed/demo without a live wiki.
