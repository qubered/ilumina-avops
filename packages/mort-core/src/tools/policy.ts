import { getEffectiveMode, getEffectiveThreshold } from "../memory/config";
import { getSetting } from "../memory";

/**
 * Tool policy (MORT_V2_PLAN §I.3, V2-5). Tiers are enforced HERE — in the tool
 * layer and the confirm route — never by asking the prompt nicely. A model that
 * has been talked into writing to the wiki still has to get past this function,
 * and this function only ever looks at the session's role and the runtime mode.
 *
 * P4 formalises the full registry; P3 needs the `write:kb` slice of it, which is
 * what this module provides.
 */

export type ToolTier = "read" | "write:memory" | "write:kb" | "write:world" | "admin";

export type ActingUser = {
  id: string;
  /** Display attribution — an email where we have one, else the id. */
  label: string;
  role: "admin" | "member";
};

/** What a `write:kb` tool is allowed to do with this payload, and why. */
export type KbWriteRoute = {
  /** apply = execute on confirm; review = park in the admin queue; blocked = do nothing. */
  route: "apply" | "review" | "blocked";
  /** One sentence, written to be repeated to the user verbatim. */
  reason: string;
};

/**
 * Chat KB writes are frozen entirely by `chat_writes = off` — the kill switch
 * that stops Mort changing the wiki from conversation without touching Q&A.
 */
export async function chatWritesEnabled(): Promise<boolean> {
  return (await getSetting("chat_writes")) !== "off";
}

/**
 * The routing decision for one proposed KB write.
 *
 * Order matters and is deliberately most-restrictive-first: a member in shadow
 * mode with a guessed doc id gets the *member* explanation, because that's the
 * one that stays true when the mode changes.
 */
export async function resolveKbWriteRoute(
  user: ActingUser,
  opts: { confidence?: number; inventedTarget?: boolean } = {},
): Promise<KbWriteRoute> {
  if (!(await chatWritesEnabled())) {
    return {
      route: "blocked",
      reason: "Chat-originated KB writes are switched off (chat_writes = off). An admin can re-enable them.",
    };
  }

  if (user.role !== "admin") {
    return {
      route: "review",
      reason: "You're a crew member, so this goes to the admin review queue rather than straight into the wiki.",
    };
  }

  // "Invented target" is the v1 guard, moved out of the ingest turn and into the
  // tool layer where it now covers chat too: a doc id the model produced without
  // ever seeing it in a search result is either a 403 or, far worse, a real but
  // wrong page.
  if (opts.inventedTarget) {
    return {
      route: "review",
      reason: "That page id isn't one I actually found — I'm not editing a page I only guessed at, so it goes to review.",
    };
  }

  const mode = await getEffectiveMode();
  if (mode !== "live") {
    return {
      route: "review",
      reason: `Mort is in ${mode} mode, so every KB write becomes a review-queue proposal — admins included.`,
    };
  }

  const threshold = await getEffectiveThreshold();
  if (opts.confidence != null && opts.confidence < threshold) {
    return {
      route: "review",
      reason: `I'm only ${Math.round(opts.confidence * 100)}% sure about this (the bar is ${Math.round(threshold * 100)}%), so it goes to review.`,
    };
  }

  return { route: "apply", reason: "You can apply this now." };
}
