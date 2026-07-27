import { z } from "zod";
import { env } from "./env";

/**
 * Minimal client for Outline's POST-RPC API.
 * https://www.getoutline.com/developers
 */

const collectionSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const documentSchema = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string().default(""),
  url: z.string().default(""),
  collectionId: z.string().nullish(),
  template: z.boolean().nullish(),
  archivedAt: z.string().nullish(),
  deletedAt: z.string().nullish(),
  publishedAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
});

export type OutlineCollection = z.infer<typeof collectionSchema>;
export type OutlineDocument = z.infer<typeof documentSchema>;

async function rpc<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${env.OUTLINE_URL.replace(/\/$/, "")}/api/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OUTLINE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Outline API ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: T };
  return json.data as T;
}

export async function listCollections(): Promise<OutlineCollection[]> {
  const collections: OutlineCollection[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await rpc<unknown[]>("collections.list", { limit: 100, offset });
    const parsed = z.array(collectionSchema.loose()).parse(page ?? []);
    collections.push(...parsed);
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
    const parsed = z.array(documentSchema.loose()).parse(page ?? []);
    docs.push(...parsed);
    if (!page || page.length < 100) break;
  }
  return docs;
}

export async function getDocument(id: string): Promise<OutlineDocument | null> {
  try {
    const doc = await rpc<unknown>("documents.info", { id });
    return documentSchema.loose().parse(doc);
  } catch (err) {
    // Deleted docs 404; callers treat null as "gone".
    if (err instanceof Error && /\(404\)/.test(err.message)) return null;
    throw err;
  }
}

export async function getCollection(id: string): Promise<OutlineCollection | null> {
  try {
    const col = await rpc<unknown>("collections.info", { id });
    return collectionSchema.loose().parse(col);
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
