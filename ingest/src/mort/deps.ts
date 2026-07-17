import { createHash } from "node:crypto";
import { env } from "../env.js";
import {
  archiveDocument,
  createDocument,
  deleteDocument,
  ensureCollection,
  getDocument,
  uploadAttachment,
} from "../outline.js";
import { decide } from "./decide.js";
import { kbSearch } from "./kbclient.js";
import {
  addRelation,
  appendJournal,
  claimDoc,
  countAuthors,
  deleteBlob,
  deleteSourceRelations,
  enqueueReview,
  findDocByRegistryKey,
  findMortIdByOutlineId,
  getBlob,
  getSourceRelations,
  recordDocState,
  registryKey,
} from "./memory.js";
import { appendToFilesSection, extractMortRegion, spliceMortRegion } from "./region.js";
import { metaField, slugify } from "./textutil.js";
import type { TurnDeps } from "./turn.js";
import { writeMortRegion } from "./writer.js";

/** Assembles the real Mort dependencies from the concrete modules. */

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
    await writeMortRegion(existing.outlineDocumentId, args.regionBody, selfUserId);
    await addRelation(args.sourceId, existing.mortId, "updated");
    return existing.outlineDocumentId;
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

export function buildTurnDeps(selfUserId: string | null): TurnDeps {
  return {
    kbSearch,
    getDocumentText: async (docId) => (await getDocument(docId)).text,
    decide,
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
      await deleteBlob(sourceId);
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
      return { archivedDocIds };
    },
    enqueueReview: (item) =>
      enqueueReview({
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
        mortId: e.mortId,
        action: e.action,
        rationale: e.rationale,
        confidence: e.confidence,
        model: env.INGEST_AI_PROVIDER,
      }),
  };
}
