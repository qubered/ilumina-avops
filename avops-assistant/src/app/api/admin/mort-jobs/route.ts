import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { reviveJob } from "@/lib/mort-review";

/** Admin-only: re-queue a dead-lettered job. */
export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const parsed = z.object({ revive: z.coerce.number().int() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const result = await reviveJob(parsed.data.revive);
  return NextResponse.json({ revived: result.ok }, { status: result.ok ? 200 : 400 });
}
