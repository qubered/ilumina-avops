import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { embedQuery } from "@/lib/rag/embeddings";
import { searchKb } from "@/lib/rag/store";

/**
 * Internal KB search for the Mort ingest agent (MORT_PLAN §v1.5). Mort's
 * authoring service has no embeddings/Qdrant of its own; it calls this over the
 * compose network so the assistant stays the single owner of the vector store.
 * Bearer-authed with INTERNAL_API_KEY — not exposed through the public tunnel.
 */

const bodySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
});

export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!env.INTERNAL_API_KEY || token !== env.INTERNAL_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  try {
    const vector = await embedQuery(parsed.data.query);
    const hits = await searchKb(vector, parsed.data.limit ?? 5);
    return NextResponse.json({
      hits: hits.map((h) => ({
        docId: h.docId,
        title: h.title,
        url: h.url,
        breadcrumb: h.breadcrumb,
        score: h.score,
        text: h.text,
        zone: h.zone,
        system: h.system,
        docType: h.docType,
      })),
    });
  } catch (err) {
    // Graceful degradation: the caller treats this as "no KB context" rather
    // than failing the whole ingest turn.
    console.error("[internal/kb-search] failed:", err);
    return NextResponse.json({ error: "KB search unavailable" }, { status: 503 });
  }
}
