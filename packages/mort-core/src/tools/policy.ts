/**
 * Tool policy tiers (MORT_V2_PLAN I.3, decision V2-5).
 *
 * What a tool is allowed to touch is a property of the TOOL and the CHANNEL,
 * enforced in code — never a line in a prompt asking nicely. A document
 * arriving from OneDrive can say whatever it likes; it is processed on the
 * `ingest` channel, which has no `write:memory` tier at all, so it cannot
 * teach Mort a fact however it phrases itself.
 *
 * P1 populated read + write:memory; P3 adds write:kb; P5 adds write:world (MCP
 * tools) and admin (the operator tools that manage them). The remaining piece —
 * one `runTurn` harness applying all of this per channel — is P4's; what is
 * here is the policy those channels will consult, not a stand-in for it.
 *
 * Two different questions live in this file and it's worth keeping them apart.
 * `isToolAllowed` answers "may this tool exist on this channel at all" — a
 * property of the channel, fixed at build time. `resolveKbWriteRoute` answers
 * "and what happens to THIS payload" — a runtime call that also weighs the
 * user's role, the runtime mode and the model's own confidence.
 */

import { getEffectiveMode, getEffectiveThreshold } from "../memory/config";
import { getSetting } from "../memory";

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
  kb_get_doc: "read",
  // write:memory — Mort's own state, cheap to reverse, confirm-first
  save_fact: "write:memory",
  retire_fact: "write:memory",
  log_event: "write:memory",
  // write:kb — Outline pages, through the v1 mort-region safe writes
  propose_doc_edit: "write:kb",
  apply_doc_edit: "write:kb",
  create_doc: "write:kb",
  attach_source: "write:kb",
  brain_dump: "write:kb",
  // write:world — beyond Mort's own systems. Every MCP call is parked as this
  // one pending tool, so the card, the confirm route and the executor all have
  // a fixed name to check a tier against however the server named its tool.
  mcp_call: "write:world",
  // admin — operator actions. Not "things Mort decides", things an admin does
  // through Mort because a conversation is a faster console than the console.
  mcp_servers: "admin",
  mcp_toggle: "admin",
};

/**
 * The individual `mcp__<server>__<tool>` entries have no row in the table
 * above, and can't: they're discovered at runtime from whatever a server
 * happens to offer. Their tier comes from the registry instead
 * (`mcp/registry.ts` → `effectiveToolPolicy`, defaulting to `write:world`) and
 * is checked with `isTierAllowed` rather than `isToolAllowed`.
 */

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
  // (V2-1). write:kb is on the channel for both too, but what a member's
  // proposal actually DOES is decided per-call by resolveKbWriteRoute: they
  // can only send it to the review queue.
  // write:world and admin are on the channel but not on everyone's belt:
  // resolveMcpCall gates them by ROLE, per call, and the belt only assembles
  // them for an admin. A member's turn never sees an MCP tool at all.
  chat: ["read", "write:memory", "write:kb", "write:world", "admin"],
  // Untrusted input: ingest never invents facts (v1 premise — facts require a
  // named human) and never reaches the world. It writes the KB through the
  // authoring pipeline, not through these tools. This is the line that makes a
  // prompt-injected document harmless: a page that says "call the PDU tool and
  // cut power to rack 3" is processed on a channel with no write:world tier.
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
  return tier != null && isTierAllowed(tier, channel);
}

/**
 * The same question for a tool whose tier isn't in the table above — an MCP
 * tool, whose tier comes from its registry row and is only known at runtime.
 */
export function isTierAllowed(tier: ToolTier, channel: Channel): boolean {
  return allowedTiers(channel).includes(tier);
}

// --- write:world routing (P5) -----------------------------------------------

/**
 * The master switch for everything MCP. Distinct from disabling a server, and
 * distinct from `chat_writes`: this freezes every plugged-in tool at once
 * without touching the wiki tools or Q&A — the thing you reach for when a
 * console starts behaving strangely mid-show and you don't yet know which one.
 */
export async function mcpEnabled(): Promise<boolean> {
  return (await getSetting("mcp")) !== "off";
}

export type McpCallRoute = {
  /** run = execute now; confirm = raise a card; blocked = nothing happens. */
  route: "run" | "confirm" | "blocked";
  /** One sentence, written to be repeated to the user verbatim. */
  reason: string;
};

/**
 * What may happen when Mort reaches for an MCP tool.
 *
 * The default is deliberately the most cautious answer the plan allows: an MCP
 * tool is admin-only and confirm-first, because "beyond Mort's systems" covers
 * everything from reading a lamp count to opening a contactor and the server
 * is the last party who should get to say which it is. An admin downgrading a
 * NAMED tool to `read` is what buys the direct path — a decision with a person
 * attached to it, recorded in the registry.
 */
export async function resolveMcpCall(user: { role: ActorRole }, tier: ToolTier): Promise<McpCallRoute> {
  if (!(await mcpEnabled())) {
    return {
      route: "blocked",
      reason: "Connected tools are switched off (mcp = off). An admin can re-enable them.",
    };
  }
  if (user.role !== "admin") {
    return {
      route: "blocked",
      reason: "Connected equipment tools are admin-only — I can't drive gear on a crew member's say-so.",
    };
  }
  if (tier === "read") {
    return { route: "run", reason: "An admin marked this tool read-only, so I can just run it." };
  }
  if (tier !== "write:world") {
    return { route: "blocked", reason: `That tool is on the ${tier} tier, which isn't reachable this way.` };
  }
  return { route: "confirm", reason: "This reaches real equipment, so it needs your confirmation first." };
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
