import {
  appendJournal,
  getReviewItem,
  listPendingReviews,
  resolveReview,
  type JournalChannel,
  type ReviewRow,
} from "../memory";
import { executeReview } from "./execute";
import { documentUrl, getSelfUserId } from "./outline";
import { buildWriteDeps } from "./write-deps";

/**
 * Deciding a review-queue proposal, in one place (MORT_V2_PLAN Part II).
 *
 * This used to live in the assistant's admin lib, which was fine while the
 * console was the only door onto the queue. P8 adds a second — an admin
 * triaging the queue from a conversation — and two doors onto the same decision
 * is exactly the shape that grows two slightly different decisions. So the
 * decision moved down here, and both doors call it.
 *
 * What stays the caller's business is who is deciding and where they came
 * through: `decidedBy` is read from a session by the route or the tool's
 * context, never from anything typed or generated, and the channel says which
 * door — so the journal can still tell a console approval from a chat one.
 */

/** Proposals a human can act on right now, oldest first. */
export async function pendingReviews(limit = 200): Promise<ReviewRow[]> {
  return listPendingReviews(limit);
}

export type ReviewDecision = "approve" | "reject";

export type ReviewDecisionResult =
  | { ok: true; id: number; status: "approved"; executed: string; docId: string; docUrl: string | null }
  | { ok: true; id: number; status: "rejected" }
  | {
      ok: false;
      id: number;
      reason: "not_found" | "already_decided" | "execute_failed";
      /** One sentence, written to be shown to the person who asked. */
      message: string;
    };

export type ReviewDecisionContext = {
  /** The deciding human, from a session. Never model-supplied. */
  decidedBy?: string | null;
  /** Which door they came through — the console or a conversation. */
  channel: JournalChannel;
  conversationId?: string | null;
};

/**
 * Approve or reject one proposal.
 *
 * Rejecting only closes the row: the bytes and the source stay, because
 * rejecting "attach this to THAT page" says nothing about whether the file
 * belongs somewhere else, and Mort re-checks his library whenever a new page
 * appears.
 *
 * Approving executes first and marks the row afterwards. If the executor can't
 * carry the action out — an ATTACH whose target was stripped, a tombstone with
 * no removal flow — the item is left pending rather than marked approved, so
 * nothing is ever recorded as done that didn't happen.
 */
export async function decideReviewItem(
  id: number,
  decision: ReviewDecision,
  ctx: ReviewDecisionContext,
): Promise<ReviewDecisionResult> {
  const item = await getReviewItem(id);
  if (!item) {
    return { ok: false, id, reason: "not_found", message: `There's no proposal #${id} in the queue.` };
  }
  if (item.status !== "pending") {
    return {
      ok: false,
      id,
      reason: "already_decided",
      message: `Proposal #${id} was already ${item.status} — nothing to do.`,
    };
  }

  if (decision === "reject") {
    await resolveReview(id, "rejected", ctx.decidedBy ?? undefined);
    await appendJournal({
      sourceId: item.source_id,
      action: `rejected:${item.action}`,
      rationale: `review ${id}`,
      channel: ctx.channel,
      actor: ctx.decidedBy ?? null,
      conversationId: ctx.conversationId ?? null,
    });
    return { ok: true, id, status: "rejected" };
  }

  try {
    const selfUserId = await getSelfUserId().catch(() => null);
    // The write is Mort's, but the decision to make it is this person's — the
    // journal records them, from the session, not from anything typed.
    const result = await executeReview(
      item,
      buildWriteDeps(selfUserId, {
        channel: ctx.channel,
        actor: ctx.decidedBy ?? null,
        conversationId: ctx.conversationId ?? null,
      }),
    );
    await resolveReview(id, "approved", ctx.decidedBy ?? undefined);
    await appendJournal({
      sourceId: item.source_id,
      outlineDocumentId: result.docId,
      action: `approved:${item.action}`,
      rationale: `review ${id}`,
      channel: ctx.channel,
      actor: ctx.decidedBy ?? null,
      conversationId: ctx.conversationId ?? null,
    });
    return {
      ok: true,
      id,
      status: "approved",
      executed: result.executed,
      docId: result.docId,
      docUrl: result.docId ? documentUrl({ id: result.docId }) : null,
    };
  } catch (err) {
    console.error(`[mort] executing review ${id} failed:`, err);
    return {
      ok: false,
      id,
      reason: "execute_failed",
      message: `Couldn't carry out proposal #${id}: ${err instanceof Error ? err.message : "execute failed"}. It's still in the queue.`,
    };
  }
}

/**
 * Whether a proposal can be approved at all, and why not — re-exported from the
 * leaf module so a caller that already has `kb/review` doesn't need a second
 * import, while the admin list (a browser component) can reach the predicates
 * without dragging Postgres and Outline in behind them.
 */
export { DREAM_LABEL, isDreamProposal, reviewActionable, whyNotActionable } from "./review-shape";
export type { ReviewShape } from "./review-shape";
