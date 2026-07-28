import { NextResponse } from "next/server";
import { claimPendingAction } from "@mort/core/memory/pending";
import { guardDecision } from "@/lib/mort-actions";

/**
 * Drop a card. Nothing is written and nothing is journalled beyond the row's
 * own status — a declined suggestion is not an event in the venue's history.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/mort/actions/[id]/cancel">) {
  // allowNonApplicable: dropping a card is the safe outcome, so it stays
  // available even once applying it no longer is — the mode flipped to shadow
  // while it sat there, chat writes were frozen, the raiser was demoted. Being
  // unable to dismiss a card you can no longer act on is the worst of both.
  const guard = await guardDecision(ctx.params, { allowNonApplicable: true });
  if (!guard.ok) return guard.response;

  const cancelled = await claimPendingAction(guard.action.id, "cancelled", guard.session.user.id);
  if (!cancelled) return NextResponse.json({ error: "That confirmation was already decided." }, { status: 409 });

  return NextResponse.json({ id: cancelled.id, status: "cancelled" });
}
