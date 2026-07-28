/**
 * Tool policy tiers (MORT_V2_PLAN I.3, decision V2-5).
 *
 * What a tool is allowed to touch is a property of the TOOL and the CHANNEL,
 * enforced in code — never a line in a prompt asking nicely. A document
 * arriving from OneDrive can say whatever it likes; it is processed on the
 * `ingest` channel, which has no `write:memory` tier at all, so it cannot
 * teach Mort a fact however it phrases itself.
 *
 * P1 populates the tiers it needs (read + write:memory). The full registry —
 * write:kb, write:world, admin — lands with the harness in P4; the shape here
 * is what it grows into, not a stand-in for it.
 */

export type ToolTier = "read" | "write:memory" | "write:kb" | "write:world" | "admin";

export type Channel = "chat" | "ingest" | "dream";

/** Roles as the auth plugin issues them. Anything unrecognised is a member. */
export type ActorRole = "admin" | "member";

export const TOOL_TIERS: Record<string, ToolTier> = {
  // read
  kb_search: "read",
  event_log: "read",
  mort_memory: "read",
  current_state: "read",
  list_pending: "read",
  // write:memory — Mort's own state, cheap to reverse, confirm-first
  save_fact: "write:memory",
  retire_fact: "write:memory",
  log_event: "write:memory",
};

/**
 * `confirm_pending` is deliberately absent from the table above: it isn't a
 * tier of its own, it's the trigger for whatever tier the card it points at
 * carries. The harness re-checks THAT tool's tier at confirm time, so calling
 * this can never reach further than the original tool was allowed to.
 */
export const CONFIRM_TOOL = "confirm_pending";

const TIERS_BY_CHANNEL: Record<Channel, ToolTier[]> = {
  // Members and admins alike may teach Mort facts and events — the write is
  // confirm-first and reversible, and the person in the chat is the approver
  // (V2-1). KB writes (write:kb) arrive in P3.
  chat: ["read", "write:memory"],
  // Untrusted input: ingest never invents facts (v1 premise — facts require a
  // named human) and never reaches the world.
  ingest: ["read"],
  dream: ["read"],
};

export function allowedTiers(channel: Channel): ToolTier[] {
  return TIERS_BY_CHANNEL[channel];
}

export function toolTier(tool: string): ToolTier | null {
  return TOOL_TIERS[tool] ?? null;
}

/**
 * May this tool run on this channel? Unknown tools are denied — a tool with no
 * declared tier is a tool nobody decided the blast radius of.
 */
export function isToolAllowed(tool: string, channel: Channel): boolean {
  const tier = toolTier(tool);
  return tier != null && allowedTiers(channel).includes(tier);
}
