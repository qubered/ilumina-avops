/**
 * The vocabulary of the tool harness (MORT_V2_PLAN I.2, I.3).
 *
 * Deliberately a leaf module with no imports at all: the policy, the registry,
 * the spend ledger, the tool audit and the per-channel step caps all need these
 * three types, and any one of them importing another to get them would be a
 * cycle waiting to happen.
 */

/**
 * How far a tool can reach. The tier is a property of the TOOL — decided once,
 * in code, when the tool is written — and the channel/role rules in policy.ts
 * are expressed entirely in terms of it. Nothing in a prompt can change either.
 */
export type ToolTier =
  /** No side effects. */
  | "read"
  /** Mort's own state — facts, events, lessons. Cheap to reverse. */
  | "write:memory"
  /** Outline pages, through the mort-region safe writes. */
  | "write:kb"
  /** Anything beyond Mort's own systems — MCP-provided tools (P5). */
  | "write:world"
  /** Operator actions: deciding reviews, flipping the mode, toggling servers. */
  | "admin";

export const TOOL_TIERS_ORDER: ToolTier[] = ["read", "write:memory", "write:kb", "write:world", "admin"];

/** How a turn started. `admin` is a console action, not an agent turn. */
export type Channel = "chat" | "ingest" | "dream";

export const CHANNELS: Channel[] = ["chat", "ingest", "dream"];

export function isChannel(v: unknown): v is Channel {
  return typeof v === "string" && (CHANNELS as string[]).includes(v);
}

/**
 * Where a chat turn is being had (MORT_V2_PLAN Part II, "widget parity").
 *
 * The channel says a conversation is happening; the surface says how much of
 * the conversation the person can actually see. The compact widget is a panel
 * inside an Outline iframe — a few hundred pixels with no room for a page diff
 * and nowhere to put the "open the page" link that makes one reviewable. So the
 * widget gets read and teach, and the wiki tools stay in the full app.
 *
 * This is a narrowing, never a widening: a surface can only take tiers away.
 * A turn that doesn't say which surface it is on is treated as the full app,
 * which is what every non-chat caller wants and what the ingest and dream
 * channels — which have no surface at all — need to keep their belts.
 */
export type Surface = "app" | "widget";

export const SURFACES: Surface[] = ["app", "widget"];

export function isSurface(v: unknown): v is Surface {
  return typeof v === "string" && (SURFACES as string[]).includes(v);
}

/** Roles as the auth plugin issues them. Anything unrecognised is a member. */
export type ActorRole = "admin" | "member";
