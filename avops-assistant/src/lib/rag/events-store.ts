import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";
import { env } from "../env";
import { embeddingDim } from "./embeddings";

/**
 * Event vectors live in their OWN Qdrant collection (R1), kept apart from the KB
 * collection so operational history can't dilute procedure search or break the
 * assistant's citation shape. The assistant is the single owner; the ingest
 * pushes rows here to index.
 */
export const EVENTS_COLLECTION = "ilumina_events";

let client: QdrantClient | null = null;
function qc(): QdrantClient {
  if (!client) client = new QdrantClient({ url: env.QDRANT_URL });
  return client;
}

export type EventPayload = {
  sourceId: string;
  rowHash: string;
  actionText: string;
  occurredOn: string | null;
  event: string | null;
  zone: string[];
  system: string[];
  entities: string[];
};

/** Deterministic UUID from (source, row) so re-index updates the same point. */
export function eventPointId(sourceId: string, rowHash: string): string {
  const h = createHash("sha256").update(`${sourceId}:${rowHash}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function ensureEventsCollection(): Promise<void> {
  const q = qc();
  const size = await embeddingDim();
  const { exists } = await q.collectionExists(EVENTS_COLLECTION);
  if (exists) {
    const info = await q.getCollection(EVENTS_COLLECTION);
    const current = (info.config.params.vectors as { size?: number })?.size;
    if (current === size) return;
    await q.deleteCollection(EVENTS_COLLECTION);
  }
  await q.createCollection(EVENTS_COLLECTION, { vectors: { size, distance: "Cosine" } });
  await q.createPayloadIndex(EVENTS_COLLECTION, { field_name: "sourceId", field_schema: "keyword", wait: true });
  await q.createPayloadIndex(EVENTS_COLLECTION, { field_name: "rowHash", field_schema: "keyword", wait: true });
}

export async function upsertEvents(points: { vector: number[]; payload: EventPayload }[]): Promise<void> {
  if (points.length === 0) return;
  await qc().upsert(EVENTS_COLLECTION, {
    wait: true,
    points: points.map((p) => ({
      id: eventPointId(p.payload.sourceId, p.payload.rowHash),
      vector: p.vector,
      payload: p.payload,
    })),
  });
}

/** Delete a source's event points whose rowHash is no longer in the sheet. */
export async function pruneEvents(sourceId: string, keepHashes: string[]): Promise<void> {
  await qc().delete(EVENTS_COLLECTION, {
    wait: true,
    filter: {
      must: [{ key: "sourceId", match: { value: sourceId } }],
      must_not: keepHashes.length ? [{ key: "rowHash", match: { any: keepHashes } }] : [],
    },
  });
}

export type EventHit = EventPayload & { score: number };

export async function searchEvents(vector: number[], limit = 6): Promise<EventHit[]> {
  try {
    const res = await qc().query(EVENTS_COLLECTION, { query: vector, limit, with_payload: true });
    return res.points.map((p) => ({ ...(p.payload as EventPayload), score: p.score ?? 0 }));
  } catch {
    // Collection may not exist yet (no events indexed) → no results, not an error.
    return [];
  }
}
