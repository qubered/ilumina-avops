import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { setChannelRails, setChatWrites, setMortMode } from "@/lib/mort-admin";

const bodySchema = z
  .object({
    mode: z.enum(["off", "shadow", "live"]).optional(),
    /** The v2 kill switch: freeze chat-originated writes without touching Q&A. */
    chatWrites: z.boolean().optional(),
    /**
     * Per-channel rails (P4). Bounds are the same ones core clamps to — stated
     * here as well so a bad value is a 400 with a reason rather than a silent
     * clamp the admin never learns about.
     */
    channel: z.enum(["chat", "ingest", "dream"]).optional(),
    maxSteps: z.number().int().min(1).max(40).optional(),
    budget: z.number().int().min(0).optional(),
  })
  .refine((b) => b.mode !== undefined || b.chatWrites !== undefined || b.channel !== undefined, {
    message: "Nothing to set",
  })
  .refine((b) => b.channel === undefined || b.maxSteps !== undefined || b.budget !== undefined, {
    message: "Naming a channel without a rail to set does nothing",
  });

/** Admin-only: set Mort's authoring mode, kill switches and per-channel rails. */
export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  if (parsed.data.chatWrites !== undefined) await setChatWrites(parsed.data.chatWrites);
  if (parsed.data.channel !== undefined) {
    await setChannelRails(parsed.data.channel, {
      maxSteps: parsed.data.maxSteps,
      budget: parsed.data.budget,
    });
  }
  if (parsed.data.mode !== undefined) {
    const result = await setMortMode(parsed.data.mode);
    if (!result.ok) return NextResponse.json(result.json, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
