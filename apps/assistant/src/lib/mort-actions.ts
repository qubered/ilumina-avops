import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getPendingAction, isKbWriteTool, pendingToolTier, type PendingAction } from "@mort/core/memory/pending";
import { isTierAllowed, resolveKbWriteRoute } from "@mort/core/tools/policy";
import { actingUserFromSession } from "@/lib/acting-user";
import { requireSession, type Session } from "@/lib/auth";
import { conversations, db } from "@/lib/db";

/**
 * Shared guard for deciding a confirmation card.
 *
 * Everything that makes confirm-then-live safe happens here rather than in the
 * prompt: the acting user comes from the session, the card must belong to that
 * user, and the tool's policy tier is re-checked at decision time — so a card
 * raised while a tier was open can't be cashed in after it closed.
 */

export const idSchema = z.object({ id: z.string().uuid() });

export type Decision =
  | { ok: true; session: Session; action: PendingAction }
  | { ok: false; response: NextResponse };

const fail = (status: number, error: string): Decision => ({
  ok: false,
  response: NextResponse.json({ error }, { status }),
});

export async function guardDecision(
  params: Promise<{ id: string }> | { id: string },
  opts: {
    /**
     * Skip the "may this still be applied" checks. Set by the two routes that
     * don't apply anything: cancel and send-to-review. Both are the SAFE
     * outcome for a card, so both must stay available precisely when applying
     * no longer is — the mode flipped to shadow while the card sat there, chat
     * writes were frozen, or the admin who raised it was demoted. A rule that
     * exists to stop things happening must never be the reason someone can't
     * call something off.
     */
    allowNonApplicable?: boolean;
  } = {},
): Promise<Decision> {
  const session = await requireSession();
  if (!session) return fail(401, "Unauthorized");

  const parsed = idSchema.safeParse(await params);
  if (!parsed.success) return fail(400, "Invalid action id");

  const action = await getPendingAction(parsed.data.id);
  // Someone else's card is not "forbidden", it doesn't exist as far as this
  // user is concerned — no probing the queue for other people's ids.
  if (!action || action.userId !== session.user.id) return fail(404, "Not found");

  if (action.status === "expired") {
    return fail(410, "That confirmation expired. Ask Mort again and confirm the new one.");
  }
  if (action.status !== "pending") {
    return fail(409, `That confirmation was already ${action.status}.`);
  }
  // Everything below is a "may this still be APPLIED" question, and this guard
  // also fronts cancel and send-to-review. A card that can no longer be applied
  // must still be dismissable — a rule whose whole job is to stop things
  // happening must never become the reason someone can't call something off.
  if (!opts.allowNonApplicable) {
    // The card's own tier, re-derived from the stored tool name — a card
    // outlives the turn that raised it, so there is no belt left to ask.
    // Checked against the confirming user's CURRENT role: they are the person
    // it was raised with (the ownership check above), but roles change, and an
    // admin demoted since then should no longer be able to cash in a
    // write:world card.
    if (!isTierAllowed(pendingToolTier(action.tool), "chat", actingUserFromSession(session).role)) {
      return fail(403, "That action isn't allowed from chat.");
    }
    // A KB card gets its routing re-checked too, not just its tier: shadow
    // mode, the chat-writes freeze and the caller's role are all runtime state
    // that may have changed since Mort raised the card.
    if (isKbWriteTool(action.tool)) {
      const route = await resolveKbWriteRoute(actingUserFromSession(session));
      if (route.route !== "apply") return fail(403, route.reason);
    }
  }
  // Note what is NOT re-checked even then: an `mcp_call` card's master switch.
  // That check belongs to the confirm route alone, which is the only caller
  // that actually reaches equipment.

  // The card names a conversation; make sure it's still this user's.
  if (action.conversationId) {
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, action.conversationId), eq(conversations.userId, session.user.id)))
      .limit(1);
    if (!conversation) return fail(404, "Not found");
  }

  return { ok: true, session, action };
}
