# ILUMINA Ingest

Turns SharePoint files into ILUMINA AV Ops KB articles. Power Automate POSTs a
base64-encoded file to this service; it extracts the content, AI-normalises it
into a clean Outline article (routed into the best-fitting collection, with
images and the original file attached), and publishes it. The assistant's
Outline webhook then indexes it into the RAG search automatically.

Part of the `ilumina-avops` compose stack — see the assistant's README for the
full deployment.

## Endpoint

`POST /ingest` — `Authorization: Bearer <INGEST_API_KEY>`

```jsonc
{
  "fileName":      "E2 Camera Patching.docx",   // required — used for type detection + title
  "contentType":   "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "contentBase64": "UEsDBBQ…",                  // required — the file, base64-encoded
  "sourceId":      "sharepoint-item-guid",       // required — idempotency key (re-POSTs update, unchanged = skip)
  "sourceUrl":     "https://…/E2.docx",          // optional — linked at the bottom of the article
  "folderPath":    "Video/Procedures"            // optional — hint for the AI's categorisation
}
```

Response: `{ action: "created" | "updated" | "skipped", outlineDocumentId, url, collection }`.

`GET /health` → `{ ok: true }`.

Supported files: Word (`.docx`, with embedded images), PDF, Excel/CSV, PowerPoint,
images, and plain text/markdown. Unknown types fall back to text extraction.

## Power Automate flow

Expose the service on your tunnel first: add a public hostname
`ingest.<domain>` → `http://ingest:8080` to the Cloudflare tunnel (Power
Automate is cloud-hosted, so it needs a public URL).

Then build the flow:

1. **Trigger** — *When a file is created or modified (properties only)* on your
   SharePoint document library. (Add a parallel *When a file is deleted* later
   if you want deletions mirrored — not handled in v1.)
2. **Get file content** — *Get file content* using the trigger's *Identifier*.
3. **HTTP** — *POST* to `https://ingest.<domain>/ingest`
   - Header `Authorization`: `Bearer <INGEST_API_KEY>`
   - Header `Content-Type`: `application/json`
   - Body:
     ```json
     {
       "fileName": "@{triggerOutputs()?['body/{FilenameWithExtension}']}",
       "contentType": "@{body('Get_file_content')?['$content-type']}",
       "contentBase64": "@{body('Get_file_content')?['$content']}",
       "sourceId": "@{triggerOutputs()?['body/{Identifier}']}",
       "sourceUrl": "@{triggerOutputs()?['body/{Link}']}",
       "folderPath": "@{triggerOutputs()?['body/{Path}']}"
     }
     ```
   > SharePoint's *Get file content* already returns `$content` as base64, so no
   > extra encoding step is needed. If you build the body from a different
   > action, wrap the bytes with the `base64(...)` expression.

Each created/modified file flows straight into the KB. Re-runs on an unchanged
file return `skipped` (content is hashed), so the flow is safe to fire often.

## Configuration

| Env | Purpose |
|---|---|
| `INGEST_API_KEY` | Bearer token the flow must send |
| `OUTLINE_URL`, `OUTLINE_API_KEY` | The Outline instance + bot key (same as the assistant) |
| `DATABASE_URL` | Postgres — the service keeps its own `sharepoint_imports` table |
| `INGEST_AI_PROVIDER` | `openrouter` (default) · `openai` · `anthropic` (no codex) |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | for openrouter |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | for openai |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | for anthropic |
| `INGEST_DEFAULT_COLLECTION` | fallback collection if the AI can't route |

**Model quality matters here.** Normalising a messy document into a clean,
correctly-categorised article is harder than answering a chat question — small
free models produce garbled titles and metadata. Use a capable model
(the compose default is `meta-llama/llama-3.3-70b-instruct:free`; a paid model
like `claude-sonnet-5` or `gpt-4o` is markedly better for this task). This is
independent of the assistant's chat model.

## Notes / limits (v1)

- **Publishes live immediately** — AI-normalised articles go straight into the
  searchable KB with no human review step.
- **Deletions aren't mirrored** — removing a SharePoint file leaves its Outline
  article; delete it in Outline (the webhook removes it from search).
- PDF/PowerPoint image figures aren't extracted (text only); the original file
  is always attached for download. Word embedded images are extracted.
- Categorisation is the AI's best guess from existing collection names.
