import { z } from "zod";
import { env } from "../../env";

/**
 * Minimal client for Outline's POST-RPC API.
 * https://www.getoutline.com/developers
 *
 * Merges what were two independent hand-rolled clients (assistant's
 * read-only one, ingest's write-capable one) into one rpc() + one document
 * schema — both were parsing subsets of the same documents.info payload.
 */

export const BASE = env.OUTLINE_URL.replace(/\/$/, "");

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
  revision: z.number().nullish(),
  updatedBy: z.object({ id: z.string().nullish() }).nullish(),
});

export type OutlineCollection = z.infer<typeof collectionSchema>;
export type OutlineDocument = z.infer<typeof documentSchema>;

export async function rpc<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OUTLINE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Name the doc — "documents.update failed (403)" alone is undebuggable.
    const ref = (body.id ?? body.documentId) as string | undefined;
    // Outline answers 403 for "you may not" AND for "it isn't there" (it won't
    // confirm a doc exists to someone who can't see it), so say both.
    const hint =
      res.status === 403
        ? " — the Mort bot user either lacks write access to that document's collection, or the document no longer exists (Outline returns 403, not 404, for both)"
        : "";
    throw new Error(
      `Outline ${path} failed (${res.status})${ref ? ` for doc ${ref}` : ""}${hint}: ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { data?: T };
  return json.data as T;
}

export function parseCollection(raw: unknown): OutlineCollection {
  return collectionSchema.loose().parse(raw);
}

export function parseDocument(raw: unknown): OutlineDocument {
  return documentSchema.loose().parse(raw);
}
