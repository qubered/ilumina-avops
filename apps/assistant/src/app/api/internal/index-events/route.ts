import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { embedBatch } from "@/lib/rag/embeddings";
import { ensureEventsCollection, pruneEvents, upsertEvents, type EventPayload } from "@/lib/rag/events-store";

/**
 * Internal endpoint (MORT R1): the ingest pushes newly-ingested event rows here;
 * the assistant embeds them and upserts into the events Qdrant collection, then
 * prunes points whose row no longer exists in the sheet. Assistant stays the
 * single Qdrant owner. Bearer-authed with INTERNAL_API_KEY.
 */
const bodySchema = z.object({
  sourceId: z.string().min(1),
  allRowHashes: z.array(z.string()),
  events: z.array(
    z.object({
      rowHash: z.string(),
      actionText: z.string(),
      occurredOn: z.string().nullable(),
      event: z.string().nullable(),
      zone: z.array(z.string()),
      system: z.array(z.string()),
      entities: z.array(z.string()),
    }),
  ),
});

export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!env.INTERNAL_API_KEY || token !== env.INTERNAL_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { sourceId, allRowHashes, events } = parsed.data;

  try {
    await ensureEventsCollection();

    if (events.length > 0) {
      const vectors = await embedBatch(
        events.map((e) => e.actionText),
        "document",
      );
      const points = events.map((e, i) => ({
        vector: vectors[i],
        payload: { sourceId, ...e } as EventPayload,
      }));
      await upsertEvents(points);
    }

    // Reconcile: drop vectors for rows removed from the sheet.
    await pruneEvents(sourceId, allRowHashes);

    return NextResponse.json({ indexed: events.length, kept: allRowHashes.length });
  } catch (err) {
    console.error("[internal/index-events] failed:", err);
    return NextResponse.json({ error: "index failed" }, { status: 503 });
  }
}
