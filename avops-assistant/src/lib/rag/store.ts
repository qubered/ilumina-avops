import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";
import { env } from "../env";
import { embeddingDim } from "./embeddings";
import type { DocMetadata } from "./metadata";

export const COLLECTION = "ilumina_kb";

export type KbPayload = {
  text: string;
  breadcrumb: string;
  docId: string;
  title: string;
  url: string;
  category: string;
  zone: string[];
  system: string[];
  docType: string[];
};

export type SearchHit = KbPayload & { score: number };

let client: QdrantClient | null = null;

export function getQdrant(): QdrantClient {
  if (!client) {
    client = new QdrantClient({ url: env.QDRANT_URL });
  }
  return client;
}

export async function ensureCollection(): Promise<void> {
  const qdrant = getQdrant();
  const size = await embeddingDim();
  const { exists } = await qdrant.collectionExists(COLLECTION);

  if (exists) {
    // Embedding models aren't interchangeable: if the configured model's
    // dimension differs from the collection, the old vectors are useless.
    // Recreate and let the next full sync re-index everything.
    const info = await qdrant.getCollection(COLLECTION);
    const current = (info.config.params.vectors as { size?: number })?.size;
    if (current === size) return;
    console.warn(
      `[qdrant] embedding dimension changed (${current} → ${size}); recreating "${COLLECTION}" — run a full re-sync`,
    );
    await qdrant.deleteCollection(COLLECTION);
  }

  await qdrant.createCollection(COLLECTION, {
    vectors: { size, distance: "Cosine" },
  });
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "docId",
    field_schema: "keyword",
    wait: true,
  });
}

export async function deleteDocPoints(docId: string): Promise<void> {
  await getQdrant().delete(COLLECTION, {
    wait: true,
    filter: { must: [{ key: "docId", match: { value: docId } }] },
  });
}

export async function upsertChunks(
  points: { vector: number[]; payload: KbPayload }[],
): Promise<void> {
  if (points.length === 0) return;
  await getQdrant().upsert(COLLECTION, {
    wait: true,
    points: points.map((p) => ({
      id: randomUUID(),
      vector: p.vector,
      payload: p.payload,
    })),
  });
}

export async function searchKb(
  vector: number[],
  limit = 5,
): Promise<SearchHit[]> {
  const result = await getQdrant().query(COLLECTION, {
    query: vector,
    limit,
    with_payload: true,
  });
  return result.points.map((point) => ({
    ...(point.payload as KbPayload),
    score: point.score ?? 0,
  }));
}

export async function countPoints(): Promise<number> {
  const { count } = await getQdrant().count(COLLECTION, { exact: true });
  return count;
}

export function metadataToPayload(
  meta: DocMetadata,
): Pick<KbPayload, "zone" | "system" | "docType"> {
  return { zone: meta.zone, system: meta.system, docType: meta.docType };
}
