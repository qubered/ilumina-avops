import { env } from "./env.js";

/**
 * Minimal Outline API client for ingestion: list collections, create/update
 * documents, and upload attachments.
 */

const BASE = env.OUTLINE_URL.replace(/\/$/, "");

async function rpc<T>(path: string, body: Record<string, unknown>): Promise<T> {
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
    throw new Error(`Outline ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: T };
  return json.data as T;
}

export type Collection = { id: string; name: string };

export async function listCollections(): Promise<Collection[]> {
  const out: Collection[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await rpc<Collection[]>("collections.list", { limit: 100, offset });
    out.push(...(page ?? []).map((c) => ({ id: c.id, name: c.name })));
    if (!page || page.length < 100) break;
  }
  return out;
}

export async function createCollection(name: string): Promise<Collection> {
  const c = await rpc<Collection>("collections.create", { name });
  return { id: c.id, name: c.name };
}

/** Ensure a collection exists by name (case-insensitive); create if missing. */
export async function ensureCollection(name: string): Promise<Collection> {
  const existing = await listCollections();
  const match = existing.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (match) return match;
  return createCollection(name);
}

export type OutlineDoc = { id: string; url: string; title: string; revision?: number };

export async function createDocument(input: {
  title: string;
  text: string;
  collectionId: string;
  publish: boolean;
}): Promise<OutlineDoc> {
  const d = await rpc<{ id: string; url: string; title: string; revision?: number }>("documents.create", input);
  return { id: d.id, url: `${BASE}${d.url}`, title: d.title, revision: d.revision };
}

export async function updateDocument(input: {
  id: string;
  title: string;
  text: string;
  publish: boolean;
}): Promise<OutlineDoc> {
  const d = await rpc<{ id: string; url: string; title: string; revision?: number }>("documents.update", input);
  return { id: d.id, url: `${BASE}${d.url}`, title: d.title, revision: d.revision };
}

/** Full current state of a doc — text + who last touched it (curated-doc detection). */
export type OutlineDocInfo = {
  id: string;
  title: string;
  text: string;
  revision: number | null;
  updatedById: string | null;
  collectionId: string | null;
};

export async function getDocument(id: string): Promise<OutlineDocInfo> {
  const d = await rpc<{
    id: string;
    title: string;
    text: string;
    revision?: number;
    updatedBy?: { id?: string } | null;
    collectionId?: string | null;
  }>("documents.info", { id });
  return {
    id: d.id,
    title: d.title,
    text: d.text ?? "",
    revision: d.revision ?? null,
    updatedById: d.updatedBy?.id ?? null,
    collectionId: d.collectionId ?? null,
  };
}

/** Permanently delete a document (used only for review-approved removals + test cleanup). */
export async function deleteDocument(id: string): Promise<void> {
  await rpc("documents.delete", { id });
}

/** Archive a document — reversible removal; preferred over delete for approved tombstones. */
export async function archiveDocument(id: string): Promise<void> {
  await rpc("documents.archive", { id });
}

/** The bot's own Outline user id — so `updatedById !== me` means a human edited it. */
export async function getSelfUserId(): Promise<string | null> {
  const d = await rpc<{ id?: string }>("auth.info", {});
  // auth.info returns { user, team }; some versions nest under .user.
  const anyD = d as unknown as { id?: string; user?: { id?: string } };
  return anyD.user?.id ?? anyD.id ?? null;
}

/**
 * Upload a file as an attachment on a document. Returns the relative
 * attachment redirect URL to embed/link in markdown — the assistant's sync
 * rewrites these to its authenticated proxy for RAG rendering.
 */
export async function uploadAttachment(input: {
  documentId: string;
  name: string;
  contentType: string;
  data: Buffer;
}): Promise<{ id: string; url: string }> {
  const created = await rpc<{
    uploadUrl: string;
    form: Record<string, string>;
    attachment: { id: string };
  }>("attachments.create", {
    name: input.name,
    contentType: input.contentType,
    size: input.data.length,
    documentId: input.documentId,
    preset: "documentAttachment",
  });

  const form = new FormData();
  for (const [k, v] of Object.entries(created.form)) form.append(k, v);
  form.append(
    "file",
    new Blob([new Uint8Array(input.data)], { type: input.contentType }),
    input.name,
  );

  const uploadUrl = created.uploadUrl.startsWith("http")
    ? created.uploadUrl
    : `${BASE}${created.uploadUrl}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OUTLINE_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Outline attachment upload failed (${res.status}): ${text.slice(0, 200)}`);
  }

  return {
    id: created.attachment.id,
    url: `/api/attachments.redirect?id=${created.attachment.id}`,
  };
}
