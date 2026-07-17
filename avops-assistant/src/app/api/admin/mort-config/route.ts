import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { setMortMode } from "@/lib/mort-review";

/** Admin-only: set Mort's authoring mode at runtime (proxies to the ingest service). */
export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const parsed = z.object({ mode: z.enum(["off", "shadow", "live"]) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const result = await setMortMode(parsed.data.mode);
  return NextResponse.json(result.json, { status: result.ok ? 200 : result.status });
}
