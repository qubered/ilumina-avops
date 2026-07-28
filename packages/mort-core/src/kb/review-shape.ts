/**
 * What a review-queue proposal IS, as opposed to what deciding one does.
 *
 * A leaf module with no imports at all, for the same reason `tools/types.ts` is
 * one: three callers need these answers and one of them is a browser component.
 * `kb/review.ts` reaches Postgres and Outline the moment it is imported, so the
 * admin list would have had to keep its own copy of "can this be approved?" —
 * and a second copy of that question is how the console and the conversation
 * start describing the same queue differently.
 */

/** Only these can actually be carried out; everything else is dismiss-only. */
const EXECUTABLE = new Set(["CREATE", "UPDATE_ADDITIVE", "ATTACH", "tombstone"]);
const NEEDS_TARGET = new Set(["UPDATE_ADDITIVE", "ATTACH"]);

/** The minimum of a proposal needed to judge it. */
export type ReviewShape = { action: string; target_doc_id?: string | null };

/**
 * A nightly-pass observation (R7). Deliberately never approvable: there is no
 * edit queued behind it. It's Mort saying something about the KB's shape, and
 * what to do about it is a judgement call he shouldn't be making for anyone.
 */
export function isDreamProposal(action: string): boolean {
  return action.startsWith("DREAM:");
}

export const DREAM_LABEL: Record<string, string> = {
  "DREAM:MISSING_PAGE": "Nothing covers this",
  "DREAM:CONTRADICTION": "These disagree",
  "DREAM:MERGE": "Same page twice",
  "DREAM:SPLIT": "Two topics, one page",
};

/**
 * Can this proposal be approved as it stands?
 *
 * An ATTACH or UPDATE whose target was stripped — Mort guessed a doc id, and
 * the invented-target guard removed it — has nowhere to go. Offering Approve
 * for one just hands the admin a 422.
 */
export function reviewActionable(item: ReviewShape): boolean {
  if (!EXECUTABLE.has(item.action)) return false;
  if (NEEDS_TARGET.has(item.action) && !item.target_doc_id) return false;
  return true;
}

/** And if not, why not — one sentence, the same one on both doors. */
export function whyNotActionable(item: ReviewShape): string {
  if (NEEDS_TARGET.has(item.action) && !item.target_doc_id) {
    return "no valid target page — Mort guessed one, so there's nothing to write to. It can only be dismissed.";
  }
  if (isDreamProposal(item.action)) {
    return "something Mort noticed across the whole KB — no edit is queued behind it. Act on it yourself, or dismiss it.";
  }
  return "flagged for a human — there's no action queued behind it, so it can only be dismissed.";
}
