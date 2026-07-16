import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { decideReview } from "@/lib/mort-review";

/** Admin-only proxy: approve/reject a Mort proposal (executes in the ingest service). */
export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const parsed = z
    .object({ id: z.number().int(), decision: z.enum(["approve", "reject"]) })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const result = await decideReview(parsed.data.id, parsed.data.decision, session.user.email ?? session.user.id);
  return NextResponse.json(result.json, { status: result.ok ? 200 : result.status });
}
