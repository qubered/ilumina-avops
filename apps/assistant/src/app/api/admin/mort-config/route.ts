import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { setChatWrites, setMortMode } from "@/lib/mort-admin";

const bodySchema = z
  .object({
    mode: z.enum(["off", "shadow", "live"]).optional(),
    /** The v2 kill switch: freeze chat-originated writes without touching Q&A. */
    chatWrites: z.boolean().optional(),
  })
  .refine((b) => b.mode !== undefined || b.chatWrites !== undefined, { message: "Nothing to set" });

/** Admin-only: set Mort's authoring mode / chat-write switch at runtime. */
export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  if (parsed.data.chatWrites !== undefined) await setChatWrites(parsed.data.chatWrites);
  if (parsed.data.mode !== undefined) {
    const result = await setMortMode(parsed.data.mode);
    if (!result.ok) return NextResponse.json(result.json, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
