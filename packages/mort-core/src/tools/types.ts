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

/** Roles as the auth plugin issues them. Anything unrecognised is a member. */
export type ActorRole = "admin" | "member";
