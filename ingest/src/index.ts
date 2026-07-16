import "./preload.js"; // must run before @ai-sdk/openai loads — see preload.ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { env } from "./env.js";
import { extract } from "./extract.js";
import { normalise } from "./normalise.js";
import {
  createDocument,
  ensureCollection,
  listCollections,
  updateDocument,
  uploadAttachment,
} from "./outline.js";
import { getImport, hashContent, initStore, upsertImport } from "./store.js";
import type { MiddlewareHandler } from "hono";
import { initMortSchema } from "./mort/schema.js";
import {
  appendJournal,
  deleteBlob,
  enqueueReview,
  getReviewItem,
  getSource,
  listPendingReviews,
  renameSource,
  resolveReview,
  tombstoneSource,
} from "./mort/memory.js";
import { executeReview } from "./mort/execute.js";
import { enqueueTurn, getDeps, initWorker } from "./mort/worker.js";
import { getEffectiveMode, getEffectiveThreshold, setMode } from "./mort/config.js";

const bodySchema = z.object({
  fileName: z.string().min(1),
  contentType: z.string().default("application/octet-stream"),
  contentBase64: z.string().min(1),
  sourceId: z.string().min(1), // watcher rel path — the idempotency key
  sourceUrl: z.string().optional(),
  folderPath: z.string().optional(),
  // Mort watcher ops (v1.1). "move" carries the previous path so Mort rebinds
  // the source instead of treating a rename as delete+create.
  op: z.enum(["upsert", "move"]).optional(),
  oldSourceId: z.string().optional(),
});

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

// Bearer auth for the ingest routes. (`app.use` matches the exact path, so each
// route is listed explicitly.)
const requireIngestAuth: MiddlewareHandler = async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (token !== env.INGEST_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
};
app.use("/ingest", requireIngestAuth);
app.use("/ingest/delete", requireIngestAuth);

// Review API — used by the assistant admin UI (INTERNAL_API_KEY) and manual
// curl (INGEST_API_KEY). Accepts either bearer token.
const requireReviewAuth: MiddlewareHandler = async (c, next) => {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok = token === env.INGEST_API_KEY || (env.INTERNAL_API_KEY && token === env.INTERNAL_API_KEY);
  if (!ok) return c.json({ error: "Unauthorized" }, 401);
  await next();
};
app.use("/review", requireReviewAuth);
app.use("/review/decision", requireReviewAuth);

// Mort runtime config — the admin UI reads/sets the authoring mode without a redeploy.
app.use("/mort/config", requireReviewAuth);

app.get("/mort/config", async (c) => {
  return c.json({
    mode: await getEffectiveMode(),
    threshold: await getEffectiveThreshold(),
    envDefault: env.MORT_MODE,
  });
});

app.post("/mort/config", async (c) => {
  const parsed = z.object({ mode: z.enum(["off", "shadow", "live"]) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid body", issues: parsed.error?.issues }, 400);
  await setMode(parsed.data.mode);
  if (parsed.data.mode !== "off") await getDeps(); // warm the worker so the next file processes
  console.log(`[mort] mode set to ${parsed.data.mode} via admin`);
  return c.json({ mode: parsed.data.mode });
});

app.get("/review", async (c) => {
  const items = await listPendingReviews(200);
  return c.json({ items });
});

app.post("/review/decision", async (c) => {
  const parsed = z
    .object({ id: z.number().int(), decision: z.enum(["approve", "reject"]), decidedBy: z.string().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  const { id, decision, decidedBy } = parsed.data;

  const item = await getReviewItem(id);
  if (!item) return c.json({ error: "Not found" }, 404);
  if (item.status !== "pending") return c.json({ error: `already ${item.status}` }, 409);

  if (decision === "reject") {
    await resolveReview(id, "rejected", decidedBy);
    if (item.action === "ATTACH" && item.source_id) await deleteBlob(item.source_id);
    return c.json({ id, status: "rejected" });
  }

  // Approve → execute the proposed action, then mark approved. If the executor
  // can't handle it yet (ATTACH/tombstone), leave the item pending and 422.
  try {
    const result = await executeReview(item, await getDeps());
    await resolveReview(id, "approved", decidedBy);
    await appendJournal({ sourceId: item.source_id, mortId: result.docId, action: `approved:${item.action}`, rationale: `review ${id}` });
    return c.json({ id, status: "approved", ...result });
  } catch (err) {
    console.error(`[review] execute ${id} failed:`, err);
    return c.json({ id, status: "pending", error: err instanceof Error ? err.message : "execute failed" }, 422);
  }
});

app.post("/ingest", async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(input.contentBase64, "base64");
  } catch {
    return c.json({ error: "contentBase64 is not valid base64" }, 400);
  }
  if (buffer.length === 0) return c.json({ error: "Empty file" }, 400);

  const contentHash = hashContent(buffer);

  // Mort authoring path (v1.3). When enabled, /ingest enqueues an async turn and
  // returns 202; the legacy one-file-one-article flow below runs only when
  // MORT_MODE=off, so existing deployments are unchanged until they opt in.
  const mortMode = await getEffectiveMode();
  if (mortMode !== "off") {
    if (input.op === "move" && input.oldSourceId) {
      await renameSource(input.oldSourceId, input.sourceId);
      return c.json({ action: "moved", from: input.oldSourceId, to: input.sourceId }, 202);
    }
    enqueueTurn({
      sourceId: input.sourceId,
      fileName: input.fileName,
      contentType: input.contentType,
      folderPath: input.folderPath,
      contentHash,
      buffer,
    });
    return c.json({ action: "queued", mode: mortMode }, 202);
  }

  try {
    // Skip work if this exact file version was already imported.
    const existing = await getImport(input.sourceId);
    if (existing && existing.contentHash === contentHash) {
      return c.json({
        action: "skipped",
        reason: "unchanged",
        outlineDocumentId: existing.outlineDocumentId,
      });
    }

    // 1. Extract markdown + images from the raw file.
    const extraction = await extract(input.fileName, input.contentType, buffer);

    // 2. AI-normalise into a KB article + route into a collection.
    const collections = await listCollections();
    const article = await normalise({
      fileName: input.fileName,
      folderPath: input.folderPath,
      markdown: extraction.markdown,
      collections: collections.map((col) => col.name),
      imageTokens: extraction.images.map((img) => img.token),
    });

    const collection = await ensureCollection(article.collectionName || env.INGEST_DEFAULT_COLLECTION);

    // 3. Create (or reuse) the Outline document so attachments have a home.
    let docId = existing?.outlineDocumentId ?? null;
    if (!docId) {
      const created = await createDocument({
        title: article.title,
        text: buildBody(article, "", input.sourceUrl),
        collectionId: collection.id,
        publish: true,
      });
      docId = created.id;
    }

    // 4. Upload images + the original file, swap tokens for attachment URLs.
    let body = extraction.markdown;
    for (const image of extraction.images) {
      const uploaded = await uploadAttachment({
        documentId: docId,
        name: image.name,
        contentType: image.contentType,
        data: image.data,
      });
      body = body.split(image.token).join(uploaded.url);
    }
    const original = await uploadAttachment({
      documentId: docId,
      name: input.fileName,
      contentType: input.contentType,
      data: buffer,
    });

    // 5. Assemble the final article and update+publish.
    const articleWithBody: typeof article = { ...article, bodyMarkdown: mergeBody(article.bodyMarkdown, body, extraction.kind) };
    const finalText = buildBody(articleWithBody, `📎 Original file: [${input.fileName}](${original.url})`, input.sourceUrl);

    const doc = await updateDocument({
      id: docId,
      title: article.title,
      text: finalText,
      publish: true,
    });

    await upsertImport({
      sourceId: input.sourceId,
      outlineDocumentId: doc.id,
      title: doc.title,
      contentHash,
    });

    return c.json({
      action: existing ? "updated" : "created",
      outlineDocumentId: doc.id,
      url: doc.url,
      collection: collection.name,
    });
  } catch (err) {
    console.error("[ingest] failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Ingestion failed" },
      500,
    );
  }
});

// Deletion signal from the watcher (a file vanished from the OneDrive folder).
// FAIL-CLOSED (v1): never auto-purge — record a tombstone for human review and
// mark the source. A paused/offline sync makes present files look deleted, so a
// human confirms before anything is removed. (MORT_PLAN.md §v1.1 / §20.3)
const deleteSchema = z.object({
  sourceId: z.string().min(1),
  op: z.string().optional(),
});

app.post("/ingest/delete", async (c) => {
  const parsed = deleteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  const { sourceId } = parsed.data;
  try {
    const src = await getSource(sourceId);
    const queued = await enqueueReview({
      action: "tombstone",
      sourceId,
      rationale: `Source '${sourceId}' disappeared from the watch folder — review before removing its KB content.`,
      dedupeKey: `tombstone:${sourceId}`,
    });
    await tombstoneSource(sourceId);
    await appendJournal({
      sourceId,
      action: "tombstone_proposed",
      rationale: queued ? "queued for review" : "already queued",
    });
    return c.json({ action: "tombstoned", review: true, queued, knownRole: src?.role ?? null }, 202);
  } catch (err) {
    console.error("[ingest/delete] failed:", err);
    return c.json({ error: err instanceof Error ? err.message : "Delete failed" }, 500);
  }
});

/**
 * The AI returns a cleaned body without images; the extractor's body has the
 * images in place. Prefer the AI's structure but keep the image references:
 * if the AI body dropped the image tokens, append the image-bearing body.
 */
function mergeBody(aiBody: string, imageBody: string, kind: string): string {
  if (kind === "image") return imageBody; // the image IS the content
  const hasAttachments = /\/api\/attachments\.redirect\?id=/.test(aiBody);
  if (hasAttachments || !/\/api\/attachments\.redirect\?id=/.test(imageBody)) return aiBody;
  return `${aiBody}\n\n${imageBody}`;
}

/** Prepend the RAG metadata lines and append footer links. */
function buildBody(
  article: { zone: string; system: string; docType: string; bodyMarkdown: string },
  footer: string,
  sourceUrl?: string,
): string {
  // Blank lines (separate paragraphs) between metadata lines: Outline's
  // ProseMirror round-trip collapses single-newline-separated lines onto one
  // line, which would break the assistant's leading Zone/System/Type parser.
  const meta = [
    article.zone && article.zone !== "N/A" ? `Zone: ${article.zone}` : "",
    article.system && article.system !== "N/A" ? `System: ${article.system}` : "",
    article.docType && article.docType !== "N/A" ? `Type: ${article.docType}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const footerLines = [
    footer,
    sourceUrl ? `[View source in SharePoint](${sourceUrl})` : "",
  ].filter(Boolean);

  return [
    meta,
    article.bodyMarkdown.trim(),
    footerLines.length ? `---\n\n${footerLines.join(" · ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

await initStore();
await initMortSchema();
const bootMode = await getEffectiveMode();
if (bootMode !== "off") await initWorker();
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(
    `[ingest] listening on :${info.port} (AI: ${env.INGEST_AI_PROVIDER}, Mort: ${bootMode})`,
  );
});
