import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { actingUser } from "@/lib/mort-actor";
import { syncDocumentById } from "@/lib/rag/sync";
import { getPendingAction } from "@mort/core/memory/pending";
import {
  cancelPendingAction,
  confirmPendingAction,
  sendPendingToReview,
} from "@mort/core/tools/kb-write";

/**
 * Decide a pending Mort action — the Confirm / Send-to-review / Cancel buttons
 * on a chat card (MORT_V2_PLAN §I.4 step 3).
 *
 * The acting user comes from the SESSION, never the body: this route is the
 * only place a chat-originated write actually happens, so it is also the only
 * place that decides whose name goes on it. Core re-checks ownership, tier
 * policy and the runtime mode before executing — the mode may have flipped to
 * shadow between Mort offering the card and the user clicking it.
 */

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({ decision: z.enum(["confirm", "review", "cancel"]) });

export async function GET(_req: Request, ctx: RouteContext<"/api/mort/actions/[id]">) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = paramsSchema.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const action = await getPendingAction(params.data.id);
  if (!action || action.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ status: action.status, tool: action.tool, expiresAt: action.expiresAt });
}

export async function POST(req: Request, ctx: RouteContext<"/api/mort/actions/[id]">) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = paramsSchema.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "decision is required" }, { status: 400 });

  const actor = actingUser(session);
  const { id } = params.data;

  if (body.data.decision === "cancel") {
    const result = await cancelPendingAction(id, actor);
    return NextResponse.json(result.ok ? { status: "cancelled" } : { error: result.error }, {
      status: result.status,
    });
  }

  if (body.data.decision === "review") {
    const result = await sendPendingToReview(id, actor);
    return NextResponse.json(result.ok ? { status: "queued_for_review" } : { error: result.error }, {
      status: result.status,
    });
  }

  const result = await confirmPendingAction(id, actor, { onWritten: (docId) => syncDocumentById(docId) });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ status: "confirmed", summary: result.summary, docId: result.docId });
}
