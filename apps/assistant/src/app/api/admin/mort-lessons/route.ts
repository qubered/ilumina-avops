import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { listMortLessons, retireLesson } from "@/lib/mort-admin";

/**
 * Admin-only: read the lessons Mort has drawn from his own record, and retire
 * one (v2 P7).
 *
 * There is no create and no edit. A lesson is something the reflection
 * concluded from evidence it can point at; one typed in by hand would have no
 * evidence behind it and would be indistinguishable in the prompt from one that
 * did. If a human wants Mort to behave a certain way, that is a rule, and rules
 * live in the prompt where they can be reviewed as a whole.
 *
 * Retiring is the one human verb here, and the retirer's name comes from the
 * session — never the request body — for the same reason a fact's approver
 * does: it is provenance for a decision that changes how Mort answers.
 */
export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  return NextResponse.json({ lessons: await listMortLessons() });
}

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = z.object({ retire: z.string().uuid() }).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const actor = session.user.email ?? session.user.id;
  const { ok } = await retireLesson(parsed.data.retire, actor);
  return NextResponse.json({ retired: ok }, { status: ok ? 200 : 400 });
}
