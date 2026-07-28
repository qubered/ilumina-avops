import { NextResponse } from "next/server";
import { claimPendingAction } from "@mort/core/memory/pending";
import { guardDecision } from "@/lib/mort-actions";

/**
 * Drop a card. Nothing is written and nothing is journalled beyond the row's
 * own status — a declined suggestion is not an event in the venue's history.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/mort/actions/[id]/cancel">) {
  const guard = await guardDecision(ctx.params);
  if (!guard.ok) return guard.response;

  const cancelled = await claimPendingAction(guard.action.id, "cancelled", guard.session.user.id);
  if (!cancelled) return NextResponse.json({ error: "That confirmation was already decided." }, { status: 409 });

  return NextResponse.json({ id: cancelled.id, status: "cancelled" });
}
