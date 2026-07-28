import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createFact, getFactHistory, retireFact } from "@/lib/mort-admin";

/**
 * Admin-only: declare or retire a current-state fact, and read a fact key's
 * history. The approver is taken from the session — a fact is only
 * authoritative because a named human approved it, so it is never
 * client-supplied. The same rule covers retirement: "who decided this stopped
 * being true" is provenance, and provenance comes from the session.
 */
const createSchema = z.object({
  factKey: z.string().min(1),
  value: z.string().min(1),
  scope: z.string().optional().nullable(),
  effectiveFrom: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});

/**
 * The life of one fact key — every value it has held, newest first, each with
 * who taught it and when. Scope is part of a fact's identity, so it narrows
 * the chain: omit it for the unscoped fact, pass it for a scoped one.
 */
export async function GET(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const factKey = searchParams.get("factKey");
  if (!factKey) return NextResponse.json({ error: "factKey is required" }, { status: 400 });

  const history = await getFactHistory(factKey, searchParams.get("scope"));
  return NextResponse.json({ history });
}

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const actor = session.user.email ?? session.user.id;
  const body = await req.json().catch(() => null);

  // Retire: { retire: <id> }
  const retire = z.object({ retire: z.coerce.number().int() }).safeParse(body);
  if (retire.success) {
    const r = await retireFact(retire.data.retire, actor);
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
    approvedBy: actor,
  });
  return NextResponse.json(result.json, { status: result.ok ? 201 : result.status });
}
