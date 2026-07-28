import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { divertPendingToReview } from "@mort/core/agent/kb-tools";
import { actorLabel } from "@mort/core/agent/pending-actions";
import { claimPendingAction, isKbWriteTool } from "@mort/core/memory/pending";
import { actingUserFromSession } from "@/lib/acting-user";
import { conversations, db, messages } from "@/lib/db";
import { guardDecision } from "@/lib/mort-actions";

/**
 * Send a KB card to the admin review queue instead of applying it — the middle
 * button on a doc-edit card (MORT_V2_PLAN Part II).
 *
 * `allowNonApplicable` because this is the SAFE outcome: if the mode flipped to
 * shadow while the card was sitting there, "apply" is correctly refused but
 * "put it in front of an admin" must still work, or the user's only options are
 * to lose the change or re-ask for it.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/mort/actions/[id]/review">) {
  const guard = await guardDecision(ctx.params, { allowNonApplicable: true });
  if (!guard.ok) return guard.response;
  const { session, action } = guard;

  if (!isKbWriteTool(action.tool)) {
    return NextResponse.json(
      { error: "Only wiki changes go to the review queue — facts and events are yours to confirm." },
      { status: 400 },
    );
  }

  // Claim first so the card can't also be confirmed; "cancelled" is the right
  // terminal state for it, because as a CARD it was indeed not carried out —
  // the proposal now lives in the review queue instead.
  const claimed = await claimPendingAction(action.id, "cancelled", session.user.id);
  if (!claimed) return NextResponse.json({ error: "That confirmation was already decided." }, { status: 409 });

  const by = actorLabel(actingUserFromSession(session));
  try {
    await divertPendingToReview(claimed, by);
  } catch (err) {
    console.error(`[mort-actions] review ${action.id} failed:`, err);
    return NextResponse.json({ error: "Could not queue that for review. Try again shortly." }, { status: 500 });
  }

  const summary = `Sent to the admin review queue: ${claimed.preview ?? "a wiki change"}. Nothing was written yet.`;
  let messageId: string | null = null;
  if (claimed.conversationId) {
    const [row] = await db
      .insert(messages)
      .values({ conversationId: claimed.conversationId, role: "assistant", content: summary })
      .returning({ id: messages.id });
    messageId = row?.id ?? null;
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, claimed.conversationId));
  }

  return NextResponse.json({ id: action.id, status: "queued_for_review", summary, messageId });
}
