import { eq, notInArray } from "drizzle-orm";
import { db, kbDocuments, syncRuns } from "../db";
import {
  documentUrl,
  getCollection,
  getDocument,
  listCollections,
  listDocuments,
  shouldIndexDocument,
  type OutlineDocument,
} from "../outline";
import { chunkMarkdown } from "./chunker";
import { embedBatch } from "./embeddings";
import { parseMetadataBlock } from "./metadata";
import {
  deleteDocPoints,
  ensureCollection,
  metadataToPayload,
  upsertChunks,
} from "./store";

/**
 * Index (or re-index) a single Outline document: delete existing points,
 * chunk → embed → upsert, and record the result in kb_documents.
 * Returns the chunk count.
 */
export async function syncDocument(
  doc: OutlineDocument,
  collectionName: string,
): Promise<number> {
  const url = documentUrl(doc);
  try {
    const { metadata, body } = parseMetadataBlock(doc.text);
    const chunks = chunkMarkdown(doc.title, body);
    const vectors = await embedBatch(
      chunks.map((c) => c.text),
      "document",
    );

    await deleteDocPoints(doc.id);
    await upsertChunks(
      chunks.map((chunk, i) => ({
        vector: vectors[i],
        payload: {
          text: chunk.text,
          breadcrumb: chunk.breadcrumb,
          docId: doc.id,
          title: doc.title,
          url,
          category: collectionName,
          ...metadataToPayload(metadata),
        },
      })),
    );

    await db
      .insert(kbDocuments)
      .values({
        outlineId: doc.id,
        title: doc.title,
        collectionName,
        url,
        lastEditedAt: doc.updatedAt ? new Date(doc.updatedAt) : null,
        chunkCount: chunks.length,
        status: "synced",
        errorMessage: null,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: kbDocuments.outlineId,
        set: {
          title: doc.title,
          collectionName,
          url,
          lastEditedAt: doc.updatedAt ? new Date(doc.updatedAt) : null,
          chunkCount: chunks.length,
          status: "synced",
          errorMessage: null,
          syncedAt: new Date(),
        },
      });

    return chunks.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .insert(kbDocuments)
      .values({
        outlineId: doc.id,
        title: doc.title,
        collectionName,
        url,
        status: "error",
        errorMessage: message,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: kbDocuments.outlineId,
        set: { status: "error", errorMessage: message, syncedAt: new Date() },
      })
      .catch(() => {});
    throw err;
  }
}

/** Remove a document from the index (deleted/archived/unpublished). */
export async function removeDocument(docId: string): Promise<void> {
  await deleteDocPoints(docId);
  await db.delete(kbDocuments).where(eq(kbDocuments.outlineId, docId));
}

/** Re-index a single doc by id — used by the webhook. */
export async function syncDocumentById(docId: string): Promise<void> {
  await ensureCollection();
  const doc = await getDocument(docId);
  if (!doc || !shouldIndexDocument(doc)) {
    await removeDocument(docId);
    return;
  }
  const collection = doc.collectionId
    ? await getCollection(doc.collectionId)
    : null;
  await syncDocument(doc, collection?.name ?? "");
}

let fullSyncRunning = false;

export function isFullSyncRunning(): boolean {
  return fullSyncRunning;
}

/**
 * Full sync: every collection → every published document. Records the run in
 * sync_runs and prunes kb_documents/points for docs that disappeared.
 */
export async function fullSync(
  trigger: "manual" | "cron" | "webhook",
): Promise<{ docCount: number; chunkCount: number }> {
  if (fullSyncRunning) {
    throw new Error("A full sync is already running.");
  }
  fullSyncRunning = true;

  const [run] = await db
    .insert(syncRuns)
    .values({ trigger, status: "running" })
    .returning();

  let docCount = 0;
  let chunkCount = 0;
  let firstError: string | null = null;

  try {
    await ensureCollection();
    const collections = await listCollections();
    const seenIds: string[] = [];

    for (const collection of collections) {
      const docs = await listDocuments(collection.id);
      for (const listed of docs) {
        if (!shouldIndexDocument(listed)) continue;
        try {
          // documents.list may omit text on some Outline versions; fetch the
          // full doc to be safe.
          const doc = listed.text ? listed : await getDocument(listed.id);
          if (!doc || !shouldIndexDocument(doc)) continue;
          chunkCount += await syncDocument(doc, collection.name);
          docCount += 1;
          seenIds.push(doc.id);
        } catch (err) {
          firstError ??= err instanceof Error ? err.message : String(err);
          // Per-doc errors are recorded in kb_documents; keep going.
        }
      }
    }

    // Prune docs that no longer exist / are no longer published.
    if (seenIds.length > 0) {
      const stale = await db
        .select({ outlineId: kbDocuments.outlineId })
        .from(kbDocuments)
        .where(notInArray(kbDocuments.outlineId, seenIds));
      for (const { outlineId } of stale) {
        await removeDocument(outlineId);
      }
    }

    await db
      .update(syncRuns)
      .set({
        finishedAt: new Date(),
        docCount,
        chunkCount,
        status: firstError ? "error" : "success",
        errorMessage: firstError,
      })
      .where(eq(syncRuns.id, run.id));

    return { docCount, chunkCount };
  } catch (err) {
    await db
      .update(syncRuns)
      .set({
        finishedAt: new Date(),
        docCount,
        chunkCount,
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      .where(eq(syncRuns.id, run.id))
      .catch(() => {});
    throw err;
  } finally {
    fullSyncRunning = false;
  }
}
