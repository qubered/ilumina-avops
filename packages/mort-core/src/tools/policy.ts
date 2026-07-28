/**
 * Tool policy tiers (MORT_V2_PLAN I.3, decision V2-5).
 *
 * What a tool is allowed to touch is a property of the TOOL and the CHANNEL,
 * enforced in code — never a line in a prompt asking nicely. A document
 * arriving from OneDrive can say whatever it likes; it is processed on the
 * `ingest` channel, which has no `write:memory` tier at all, so it cannot
 * teach Mort a fact however it phrases itself.
 *
 * Three different questions live in this file and it's worth keeping them
 * apart:
 *
 *  - `isTierAllowed` — may a tool of this tier exist on this channel, for this
 *    role? A property of the channel and the role, fixed at build time.
 *  - `tierNeedsConfirmation` — and if it exists, may it fire unattended?
 *  - `resolveKbWriteRoute` — and what happens to THIS payload? A runtime call
 *    that also weighs the mode and the model's own confidence.
 *
 * Which tool carries which tier is the registry's business (tools/registry.ts),
 * because a tool and its tier should be declared in the same breath. P4 moved
 * that mapping out of here for exactly that reason — a second hand-maintained
 * table is a table that drifts.
 */

import { getEffectiveMode, getEffectiveThreshold } from "../memory/config";
import { getSetting } from "../memory/settings";
import type { ActorRole, Channel, ToolTier } from "./types";

export type { ActorRole, Channel, ToolTier } from "./types";
export { CHANNELS, isChannel, TOOL_TIERS_ORDER } from "./types";

/** `"any"` = both roles; a list = only those roles. Absent = tier is off. */
type TierRule = "any" | ActorRole[];

/**
 * The whole channel/role policy, in one table (MORT_V2_PLAN I.3).
 *
 * Read it as: on this channel, these tiers exist, and these roles may reach
 * them. Everything not listed is denied — a tier nobody wrote down is a tier
 * nobody decided the blast radius of.
 */
const CHANNEL_POLICY: Record<Channel, Partial<Record<ToolTier, TierRule>>> = {
  chat: {
    read: "any",
    // Members and admins alike may teach Mort facts and events — the write is
    // confirm-first and reversible, and the person in the chat is the approver
    // (V2-1).
    "write:memory": "any",
    // write:kb is on the channel for both roles, but what a member's proposal
    // actually DOES is decided per-call by resolveKbWriteRoute: they can only
    // send it to the review queue.
    "write:kb": "any",
    // MCP-provided tools (P5). Admins only, and even then confirm-first — see
    // tierNeedsConfirmation.
    "write:world": ["admin"],
    // Operator actions from chat (P8: admin-in-chat). No tool declares this
    // tier yet; the rule is here so adding one is a registration, not a
    // re-litigation of who may call it.
    admin: ["admin"],
  },
  // Untrusted input. Ingest never invents facts (v1 premise — facts require a
  // named human) and never reaches the world. It writes the KB through the
  // authoring pipeline, which carries its own shadow/confidence gates, not
  // through these tools.
  ingest: { read: "any" },
  // Housekeeping only. P7 adds note_lesson and propose_doc_edit here — as a
  // spec-level channel narrowing on those two tools, not by opening the whole
  // write:memory tier, which would also hand the dream save_fact.
  dream: { read: "any" },
};

export function allowedTiers(channel: Channel): ToolTier[] {
  return Object.keys(CHANNEL_POLICY[channel] ?? {}) as ToolTier[];
}

/**
 * May a tool of this tier run on this channel, for this actor?
 *
 * Unknown roles fall to `member`: the failure mode of an unrecognised role
 * string must be less access, never more.
 */
export function isTierAllowed(tier: ToolTier, channel: Channel, role: ActorRole = "member"): boolean {
  const rule = CHANNEL_POLICY[channel]?.[tier];
  if (rule === undefined) return false;
  if (rule === "any") return true;
  return rule.includes(role === "admin" ? "admin" : "member");
}

/**
 * Tiers that may never fire unattended, even for an admin on a channel that
 * allows them: the tool raises a card and a human confirms it.
 *
 * `write:world` is the whole list. Mort's own state is reversible from the
 * admin console and his KB writes only ever touch his own fenced region — a
 * lighting console is neither.
 */
export function tierNeedsConfirmation(tier: ToolTier): boolean {
  return tier === "write:world";
}

// --- write:kb routing (P3) --------------------------------------------------

/**
 * Chat KB writes are frozen entirely by `chat_writes = off` — the kill switch
 * that stops Mort changing the wiki from a conversation without touching Q&A
 * (MORT_V2_PLAN Part IV).
 */
export async function chatWritesEnabled(): Promise<boolean> {
  return (await getSetting("chat_writes")) !== "off";
}

/** What a `write:kb` tool may do with this payload, and why. */
export type KbWriteRoute = {
  /** apply = raise a card that can execute; review = admin queue; blocked = nothing. */
  route: "apply" | "review" | "blocked";
  /** One sentence, written to be repeated to the user verbatim. */
  reason: string;
};

/**
 * The routing decision for one proposed KB write.
 *
 * Order is deliberately most-durable-first: a member in shadow mode with a
 * guessed doc id gets the *member* explanation, because that's the one that
 * stays true when the mode changes tomorrow.
 */
export async function resolveKbWriteRoute(
  user: { role: ActorRole },
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

  // The v1 "never act on an invented doc id" guard, moved out of the ingest
  // turn and into the tool layer where it now covers chat too: a doc id the
  // model produced without ever seeing it in a search result is either a 403
  // or, far worse, a real but wrong page.
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
