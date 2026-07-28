import { env } from "../env";
import { countPendingActionsToday, createPendingAction, type PendingTool } from "../memory/pending";
import type { DiffLine } from "../kb/diff";
import type { ActingUser } from "./pending-actions";

/**
 * Raising a confirmation card (MORT_V2_PLAN I.4).
 *
 * Extracted from agent/index.ts in P3 so the KB write tools (agent/kb-tools.ts)
 * raise cards through exactly the same path the teaching tools do, without the
 * two modules importing each other in a circle.
 */

/** Everything a write tool needs that the model must not be able to supply. */
export type ChatToolContext = {
  conversationId: string | null;
  /** From the session. The reason a fact can carry a human's name at all. */
  user: ActingUser;
  /**
   * Outline doc ids Mort has actually seen this turn (kb_search / kb_get_doc).
   * The v1 "never act on an invented doc id" guard, moved into the tool layer
   * where it now protects chat as well as ingestion (P3).
   */
  seen: Set<string>;
  /** Re-index hook passed through to the executor; see ExecuteOptions. */
  onWritten?: (docId: string) => Promise<void>;
};

/** What a write tool hands back: a card to confirm, never a completed write. */
export type PendingCard = {
  pendingId: string;
  tool: PendingTool;
  preview: string;
  payload: Record<string, unknown>;
  status: "pending";
  note: string;
  // --- doc-edit extras (P3), absent on teaching cards ---
  /** Before/after of Mort's region, already condensed to hunks. */
  diff?: DiffLine[];
  /** Link to the page being changed. */
  docUrl?: string;
  /** Things the user should read before clicking Confirm. */
  warnings?: string[];
};

export type ToolFailure = { error: string };

export const NOT_SAVED =
  "NOT SAVED YET. This is waiting on the user's confirmation — the chat is showing them a card with Confirm / Edit / Cancel. Tell them what you're about to remember and that it needs their nod. Do not claim it is saved.";

const NOT_WRITTEN =
  "NOT WRITTEN YET. The chat is showing the user a card with the diff and a Confirm button. Say in a line or two what you're proposing and leave the card to do the rest — don't paste the page back at them, and never say the wiki has changed.";

/** Raise a card, subject to the per-user daily rail (Part IV). */
export async function raiseCard(
  ctx: ChatToolContext,
  tool: PendingTool,
  payload: Record<string, unknown>,
  preview: string,
  extra: Pick<PendingCard, "diff" | "docUrl" | "warnings"> = {},
): Promise<PendingCard | ToolFailure> {
  try {
    const raisedToday = await countPendingActionsToday(ctx.user.id);
    if (raisedToday >= env.MORT_PENDING_DAILY_LIMIT) {
      return {
        error: `This user has already raised ${raisedToday} confirmations today (the daily limit). Tell them you can't queue any more today and to confirm or clear the ones outstanding.`,
      };
    }
    const action = await createPendingAction({
      conversationId: ctx.conversationId,
      userId: ctx.user.id,
      tool,
      payload,
      preview,
    });
    return {
      pendingId: action.id,
      tool,
      preview,
      payload,
      status: "pending",
      note: extra.diff || extra.docUrl ? NOT_WRITTEN : NOT_SAVED,
      ...extra,
    };
  } catch (err) {
    console.error(`[${tool}] could not raise a confirmation:`, err);
    return { error: "Mort's memory is unreachable right now — say so, and don't claim anything was remembered." };
  }
}

/** How many more cards this user may raise today — the brain dump's budget. */
export async function remainingCardBudget(userId: string): Promise<number> {
  return Math.max(0, env.MORT_PENDING_DAILY_LIMIT - (await countPendingActionsToday(userId)));
}
