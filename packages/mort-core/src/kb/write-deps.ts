import { createHash } from "node:crypto";
import { env } from "../env";
import {
  archiveDocument,
  createDocument,
  deleteDocument,
  documentVisible,
  ensureCollection,
  getDocument,
  isOutlineDenied,
  uploadAttachment,
} from "./outline";
import {
  addRelation,
  appendJournal,
  claimDoc,
  countAuthors,
  deleteBlob,
  deleteSourceRelations,
  enqueueReview as enqueueReviewRow,
  findDocByRegistryKey,
  findMortIdByOutlineId,
  forgetDoc,
  getBlob,
  getSourceRelations,
  recordDocState,
  registryKey,
} from "../memory";
import { appendToFilesSection, extractMortRegion, spliceMortRegion } from "./region";
import { metaField, slugify } from "./textutil";
import { writeMortRegion } from "./writer";

/**
 * The write-only subset of a Mort turn's dependencies — everything
 * executeReview() needs to apply an APPROVED review-queue proposal, and
 * nothing that requires the LLM pipeline (kbSearch/understand/decide). This
 * split is what lets the assistant's admin review-approval route call
 * executeReview() directly with zero HTTP, while the real authoring pipeline
 * (classify→understand→gather→decide→worker) stays entirely in apps/ingest.
 */
export type WriteDeps = {
  /** Update Mort's region in an existing doc. */
  updateRegion: (docId: string, regionBody: string) => Promise<void>;
  /** Create a new doc with Mort's region as its body — or additively update an
   *  existing one with the same logical identity. */
  createDoc: (args: { title: string; collection: string | null; regionBody: string; sourceId: string }) => Promise<string>;
  /** Upload a previously-stored file to a doc and record it in Mort's Files
   *  section (attach executor). Optional — when absent, ATTACH is proposed. */
  attachFile?: (docId: string, sourceId: string) => Promise<void>;
  /** Approved-tombstone removal: archive docs a vanished source solely authored. */
  removeSource?: (sourceId: string) => Promise<{ archivedDocIds: string[] }>;
  /** Queue a proposal for human review (idempotent). */
  enqueueReview: (item: {
    action: string;
    sourceId: string;
    targetDocId?: string | null;
    rationale?: string;
    payload?: unknown;
    dedupeKey: string;
  }) => Promise<boolean>;
  journal: (entry: {
    sourceId: string;
    outlineDocumentId?: string | null;
    action: string;
    rationale?: string;
    confidence?: number;
    tokens?: number;
  }) => Promise<void>;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function folderOf(sourceId: string): string | null {
  const i = sourceId.lastIndexOf("/");
  return i >= 0 ? sourceId.slice(0, i) : null;
}

/**
 * Create a doc for `title` — or, if a doc with the same logical identity already
 * exists (registry key = folder + system + normalised title), additively update
 * that one instead of making a near-duplicate. A concurrent create that loses
 * the unique-constraint race cleans up its Outline duplicate and updates the winner.
 */
async function createOrUpdateDoc(
  args: { title: string; collection: string | null; regionBody: string; sourceId: string },
  selfUserId: string | null,
): Promise<string> {
  const folderOrigin = folderOf(args.sourceId);
  const system = metaField(args.regionBody, "System");
  const collName = args.collection ?? env.INGEST_DEFAULT_COLLECTION;
  // Identity is semantic (system + title) — a file moving folders must not spawn
  // a duplicate. folderOrigin is still recorded on the doc for traceability.
  const regKey = registryKey({ system, title: args.title });
  const mortId = `${slugify(args.title)}-${sha(regKey).slice(0, 6)}`;

  // Fast path: the logical doc already exists → additive update, never a dup.
  const existing = await findDocByRegistryKey(regKey);
  if (existing) {
    try {
      await writeMortRegion(existing.outlineDocumentId, args.regionBody, selfUserId);
      await addRelation(args.sourceId, existing.mortId, "updated");
      return existing.outlineDocumentId;
    } catch (err) {
      if (!isOutlineDenied(err)) throw err;
      // Outline said no. That's either "someone deleted this doc" or "the bot
      // can't write here" — and the two need opposite responses, so probe rather
      // than guess. Forgetting a live doc would duplicate it; keeping a dead one
      // 403s forever.
      if (await documentVisible(existing.outlineDocumentId)) {
        throw new Error(
          `Mort maintains doc ${existing.outlineDocumentId} but cannot write to it — grant the Mort bot ` +
            `user edit access to that document's collection in Outline. (${err instanceof Error ? err.message : err})`,
        );
      }
      console.warn(
        `[mort] registry pointed at ${existing.outlineDocumentId}, which is gone from Outline — forgetting it and recreating`,
      );
      await forgetDoc(existing.mortId);
      // fall through and create a fresh doc
    }
  }

  const coll = await ensureCollection(collName);
  const created = await createDocument({
    title: args.title,
    text: spliceMortRegion("", args.regionBody), // new doc = Mort's region only
    collectionId: coll.id,
    publish: true,
  });

  const claim = await claimDoc({
    mortId,
    outlineDocumentId: created.id,
    collection: coll.name,
    title: args.title,
    folderOrigin,
    system,
    registryKey: regKey,
  });
  if (!claim.created) {
    // Lost the create race → drop our Outline duplicate, update the winner.
    await deleteDocument(created.id);
    await writeMortRegion(claim.doc.outlineDocumentId, args.regionBody, selfUserId);
    await addRelation(args.sourceId, claim.doc.mortId, "updated");
    return claim.doc.outlineDocumentId;
  }

  await addRelation(args.sourceId, mortId, "authored");
  await recordDocState({
    outlineDocumentId: created.id,
    lastMortRevisionId: String(created.revision ?? ""),
    lastMortBodyHash: sha(args.regionBody.trim()),
  });
  return created.id;
}

/** Assembles the real write-only Mort dependencies from the concrete modules. */
export function buildWriteDeps(selfUserId: string | null): WriteDeps {
  return {
    updateRegion: async (docId, regionBody) => {
      await writeMortRegion(docId, regionBody, selfUserId);
    },
    createDoc: (args) => createOrUpdateDoc(args, selfUserId),
    attachFile: async (docId, sourceId) => {
      const blob = await getBlob(sourceId);
      if (!blob) throw new Error(`no stored bytes for '${sourceId}' to attach`);
      const uploaded = await uploadAttachment({
        documentId: docId,
        name: blob.fileName,
        contentType: blob.contentType,
        data: blob.data,
      });
      // Add the file link additively under Mort's Files section (non-destructive).
      const doc = await getDocument(docId);
      const region = extractMortRegion(doc.text) ?? "";
      const line = `- [${blob.fileName}](${uploaded.url})`;
      await writeMortRegion(docId, appendToFilesSection(region, line), selfUserId);
      const mortId = await findMortIdByOutlineId(docId);
      if (mortId) await addRelation(sourceId, mortId, "attached");
      // The bytes STAY. A file is a library asset, not a one-shot upload buffer:
      // the same schematic may belong on several pages, and pages that want it
      // may not exist yet. They're dropped when the source itself goes.
    },
    removeSource: async (sourceId) => {
      // On an approved tombstone, archive (reversible) only docs this source
      // SOLELY authored — never a shared/curated doc. Attach/update relations are
      // just dropped (their docs live on).
      const rels = await getSourceRelations(sourceId);
      const archivedDocIds: string[] = [];
      for (const r of rels) {
        if (r.relation === "authored" && (await countAuthors(r.mortId)) <= 1) {
          await archiveDocument(r.outlineDocumentId);
          archivedDocIds.push(r.outlineDocumentId);
        }
      }
      await deleteSourceRelations(sourceId);
      // The source is gone for good, so its bytes are too — this is the one
      // place blobs are reclaimed now that they outlive an attach.
      await deleteBlob(sourceId);
      return { archivedDocIds };
    },
    enqueueReview: (item) =>
      enqueueReviewRow({
        action: item.action,
        sourceId: item.sourceId,
        targetDocId: item.targetDocId,
        rationale: item.rationale,
        payload: item.payload,
        dedupeKey: item.dedupeKey,
      }),
    journal: (e) =>
      appendJournal({
        sourceId: e.sourceId,
        outlineDocumentId: e.outlineDocumentId,
        action: e.action,
        rationale: e.rationale,
        confidence: e.confidence,
        tokens: e.tokens,
        model: env.INGEST_AI_PROVIDER,
      }),
  };
}
