import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { env } from "@/lib/env";

const querySchema = z.object({ id: z.string().uuid() });

/**
 * Authenticated proxy for Outline document attachments (images/files quoted
 * in answers). The app session gates access; Outline is fetched with the
 * bot API key server-side, so crew never need an Outline session here.
 */
export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse({ id: searchParams.get("id") });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid attachment id" }, { status: 400 });
  }

  const upstream = await fetch(
    `${env.OUTLINE_URL.replace(/\/$/, "")}/api/attachments.redirect?id=${parsed.data.id}`,
    { headers: { Authorization: `Bearer ${env.OUTLINE_API_KEY}` } },
  );
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: "Attachment unavailable" },
      { status: upstream.status === 404 ? 404 : 502 },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      // Private: attachment access is session-gated.
      "Cache-Control": "private, max-age=3600",
      ...(upstream.headers.get("content-disposition")
        ? { "Content-Disposition": upstream.headers.get("content-disposition")! }
        : {}),
    },
  });
}
