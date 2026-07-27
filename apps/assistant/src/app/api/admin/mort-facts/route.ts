import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createFact, retireFact } from "@/lib/mort-review";

/**
 * Admin-only: declare or retire a current-state fact. The approver is taken from
 * the session — a fact is only authoritative because a named human approved it,
 * so it is never client-supplied.
 */
const createSchema = z.object({
  factKey: z.string().min(1),
  value: z.string().min(1),
  scope: z.string().optional().nullable(),
  effectiveFrom: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = await req.json().catch(() => null);

  // Retire: { retire: <id> }
  const retire = z.object({ retire: z.coerce.number().int() }).safeParse(body);
  if (retire.success) {
    const r = await retireFact(retire.data.retire);
    return NextResponse.json({ retired: r.ok }, { status: r.ok ? 200 : 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const result = await createFact({
    ...parsed.data,
    scope: parsed.data.scope ?? null,
    effectiveFrom: parsed.data.effectiveFrom ?? null,
    note: parsed.data.note ?? null,
    sourceTier: "human",
    confidence: "approved",
    approvedBy: session.user.email ?? session.user.id,
  });
  return NextResponse.json(result.json, { status: result.ok ? 201 : result.status });
}
