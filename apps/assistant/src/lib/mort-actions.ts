import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getPendingAction, isKbWriteTool, type PendingAction } from "@mort/core/memory/pending";
import { isToolAllowed, resolveKbWriteRoute } from "@mort/core/tools/policy";
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
     * Skip the "may this still be applied" check. Set by the review route:
     * diverting a card to the admin queue is the SAFE outcome, so it must stay
     * available precisely when applying no longer is (mode flipped to shadow
     * while the card sat there).
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
  if (!isToolAllowed(action.tool, "chat")) {
    return fail(403, "That action isn't allowed from chat.");
  }
  // A KB card gets its routing re-checked too, not just its tier: shadow mode,
  // the chat-writes freeze and the caller's role are all runtime state that may
  // have changed since Mort raised the card. "Send to review" is still open in
  // that case — see the review route, which deliberately skips this check.
  if (isKbWriteTool(action.tool) && !opts.allowNonApplicable) {
    const route = await resolveKbWriteRoute(actingUserFromSession(session));
    if (route.route !== "apply") return fail(403, route.reason);
  }

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
