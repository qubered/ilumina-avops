import { env } from "../../env";
import { parseCollection, parseDocument, rpc, type OutlineCollection, type OutlineDocument } from "./client";

export type { OutlineCollection, OutlineDocument };

export async function listCollections(): Promise<OutlineCollection[]> {
  const collections: OutlineCollection[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await rpc<unknown[]>("collections.list", { limit: 100, offset });
    collections.push(...(page ?? []).map(parseCollection));
    if (!page || page.length < 100) break;
  }
  return collections;
}

export async function listDocuments(collectionId: string): Promise<OutlineDocument[]> {
  const docs: OutlineDocument[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await rpc<unknown[]>("documents.list", {
      collectionId,
      limit: 100,
      offset,
    });
    docs.push(...(page ?? []).map(parseDocument));
    if (!page || page.length < 100) break;
  }
  return docs;
}

/** Throws on 404/403 — for callers that need a doc to exist (writer.ts, deps.ts). */
export async function getDocument(id: string): Promise<OutlineDocument> {
  return parseDocument(await rpc<unknown>("documents.info", { id }));
}

/** Catches 404 → null — for callers doing "does this still exist" checks (sync.ts). */
export async function getDocumentOrNull(id: string): Promise<OutlineDocument | null> {
  try {
    return await getDocument(id);
  } catch (err) {
    if (err instanceof Error && /\(404\)/.test(err.message)) return null;
    throw err;
  }
}

export async function getCollection(id: string): Promise<OutlineCollection | null> {
  try {
    return parseCollection(await rpc<unknown>("collections.info", { id }));
  } catch (err) {
    if (err instanceof Error && /\(404\)/.test(err.message)) return null;
    throw err;
  }
}

/**
 * Publish state gate: only published, non-template, non-archived docs are
 * crew-ready and get indexed.
 */
export function shouldIndexDocument(doc: {
  template?: boolean | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  publishedAt?: string | null;
}): boolean {
  if (doc.template) return false;
  if (doc.archivedAt) return false;
  if (doc.deletedAt) return false;
  if (!doc.publishedAt) return false;
  return true;
}

/** Absolute URL for citation links back to the Outline doc. */
export function documentUrl(doc: { url?: string | null; id: string }): string {
  const base = env.OUTLINE_URL.replace(/\/$/, "");
  if (doc.url) return doc.url.startsWith("http") ? doc.url : `${base}${doc.url}`;
  return `${base}/doc/${doc.id}`;
}
