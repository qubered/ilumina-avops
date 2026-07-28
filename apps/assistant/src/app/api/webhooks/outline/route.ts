import { NextResponse, after } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { removeDocument, syncDocumentById } from "@/lib/rag/sync";
import { verifyOutlineSignature } from "@/lib/webhook-verify";

const eventSchema = z.looseObject({
  event: z.string(),
  payload: z.looseObject({
    id: z.string().optional(),
    model: z.looseObject({ id: z.string().optional() }).optional(),
  }),
});

const REINDEX_EVENTS = new Set(["documents.publish", "documents.update"]);
const REMOVE_EVENTS = new Set([
  "documents.delete",
  "documents.archive",
  "documents.unpublish",
]);

export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get("outline-signature");

  if (!verifyOutlineSignature(signature, body, env.OUTLINE_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const parsed = eventSchema.safeParse(JSON.parse(body));
  if (!parsed.success) {
    return NextResponse.json({ error: "Unrecognized payload" }, { status: 400 });
  }

  const { event, payload } = parsed.data;
  const docId = payload.model?.id ?? payload.id;
  if (!docId || (!REINDEX_EVENTS.has(event) && !REMOVE_EVENTS.has(event))) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  // Respond 200 fast; do the work after the response is sent (brief §6.3).
  after(async () => {
    try {
      if (REMOVE_EVENTS.has(event)) {
        // documents.info re-check inside syncDocumentById also handles this,
        // but going straight to removal avoids an API round-trip.
        await removeDocument(docId);
      } else {
        await syncDocumentById(docId);
      }
      console.log(`[webhook] ${event} handled for doc ${docId}`);
    } catch (err) {
      console.error(`[webhook] ${event} failed for doc ${docId}:`, err);
    }
  });

  return NextResponse.json({ ok: true });
}
