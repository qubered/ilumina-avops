import type { Tool, ToolSet } from "ai";
import type { ChatToolContext } from "../agent/cards";
import {
  buildKbGetDocTool,
  buildKbSearchTool,
  currentStateTool,
  eventLogTool,
  mortMemoryTool,
} from "../agent/read-tools";
import {
  confirmPendingTool,
  listPendingTool,
  logEventTool,
  retireFactTool,
  saveFactTool,
} from "../agent/memory-tools";
import { attachSourceTool, brainDumpTool, createDocTool, proposeDocEditTool } from "../agent/kb-tools";
import { chatWritesEnabled, isTierAllowed } from "./policy";
import { harness, type ToolContext } from "./harness";
import type { ActorRole, Channel, ToolTier } from "./types";

/**
 * The unified tool belt (MORT_V2_PLAN I.3, decision V2-5).
 *
 * ONE list of every tool Mort has, each declaring its name, its policy tier,
 * and how to build its executor for a given turn. v1 had two Morts with two
 * separate, undeclared sets of capabilities; the point of this file is that
 * there is now exactly one place to answer "what can he do, and how far does
 * each of those reach".
 *
 * Three rules the registry enforces, all in `buildBelt`:
 *
 *  1. A tool is only on the belt when its tier is allowed on this channel for
 *     this role (tools/policy.ts). Omission is the primary defence — a tool
 *     Mort doesn't have is a tool nobody can talk him into reaching for.
 *  2. Every tool is wrapped by the harness, which re-checks that at CALL time
 *     and journals the invocation either way (tools/harness.ts).
 *  3. A tool with an `enabled` predicate that says no is left off, whatever
 *     the tiers say — that's where the kill switches live.
 *
 * `confirm_pending` is deliberately absent from the tier table: it isn't a
 * tier of its own, it's the trigger for whatever tier the card it points at
 * carries. It is registered at `read` and re-checks THAT tool's tier at
 * confirm time (see agent/memory-tools.ts), so calling it can never reach
 * further than the tool that raised the card was allowed to.
 */

export type ToolSpec = {
  name: string;
  tier: ToolTier;
  /**
   * Narrow below the tier rule. Absent = wherever the tier is allowed. Used
   * for tools that share a tier with something more dangerous: P7's
   * `note_lesson` is write:memory but belongs on the dream channel, while
   * `save_fact` — same tier — must never be.
   */
  channels?: Channel[];
  /** This tool needs a session user (all the write tools do). */
  requiresUser?: boolean;
  /** Runtime kill switches. Checked when the belt is assembled AND at call time. */
  enabled?: (ctx: ToolContext) => Promise<boolean>;
  /** Build the executor for one turn. */
  build: (ctx: ToolContext) => Tool;
};

/**
 * A turn's context, narrowed to what the chat write tools need. Safe because
 * every spec that reaches for it declares `requiresUser` and the registry
 * refuses to build those without a user present.
 */
const chatCtx = (ctx: ToolContext): ChatToolContext => ({
  conversationId: ctx.conversationId,
  messageId: ctx.messageId ?? null,
  user: ctx.user!,
  seen: ctx.seen,
  onWritten: ctx.onWritten,
});

/** Frozen by `chat_writes = off` — the wiki kill switch (Part IV). */
const kbWritesOn = () => chatWritesEnabled();

export const TOOL_SPECS: ToolSpec[] = [
  // --- read ---------------------------------------------------------------
  { name: "kb_search", tier: "read", build: (ctx) => buildKbSearchTool(ctx.seen) },
  { name: "kb_get_doc", tier: "read", build: (ctx) => buildKbGetDocTool(ctx.seen) },
  { name: "event_log", tier: "read", build: () => eventLogTool },
  { name: "mort_memory", tier: "read", build: () => mortMemoryTool },
  { name: "current_state", tier: "read", build: () => currentStateTool },
  { name: "list_pending", tier: "read", requiresUser: true, build: (ctx) => listPendingTool(chatCtx(ctx)) },
  { name: "confirm_pending", tier: "read", requiresUser: true, build: (ctx) => confirmPendingTool(chatCtx(ctx)) },

  // --- write:memory — Mort's own state, cheap to reverse, confirm-first ----
  { name: "save_fact", tier: "write:memory", requiresUser: true, build: (ctx) => saveFactTool(chatCtx(ctx)) },
  { name: "retire_fact", tier: "write:memory", requiresUser: true, build: (ctx) => retireFactTool(chatCtx(ctx)) },
  { name: "log_event", tier: "write:memory", requiresUser: true, build: (ctx) => logEventTool(chatCtx(ctx)) },

  // --- write:kb — Outline pages, through the mort-region safe writes -------
  {
    name: "propose_doc_edit",
    tier: "write:kb",
    requiresUser: true,
    enabled: kbWritesOn,
    build: (ctx) => proposeDocEditTool(chatCtx(ctx)),
  },
  {
    name: "create_doc",
    tier: "write:kb",
    requiresUser: true,
    enabled: kbWritesOn,
    build: (ctx) => createDocTool(chatCtx(ctx)),
  },
  {
    name: "attach_source",
    tier: "write:kb",
    requiresUser: true,
    enabled: kbWritesOn,
    build: (ctx) => attachSourceTool(chatCtx(ctx)),
  },
  {
    name: "brain_dump",
    tier: "write:kb",
    requiresUser: true,
    enabled: kbWritesOn,
    build: (ctx) => brainDumpTool(chatCtx(ctx)),
  },
];

const BY_NAME = new Map(TOOL_SPECS.map((s) => [s.name, s]));

/**
 * `apply_doc_edit` never appears on a belt — it is the parked form of a
 * propose_doc_edit, only ever reached by confirming a card — but it does carry
 * a tier, checked when a card is confirmed. Declared here so the one table of
 * tiers stays complete.
 */
export const CARD_ONLY_TIERS: Record<string, ToolTier> = { apply_doc_edit: "write:kb" };

/** Every tool's tier, registry-derived. The one table; nothing hand-maintained. */
export const TOOL_TIERS: Record<string, ToolTier> = Object.fromEntries([
  ...TOOL_SPECS.map((s) => [s.name, s.tier] as const),
  ...Object.entries(CARD_ONLY_TIERS),
]);

export function toolSpec(name: string): ToolSpec | null {
  return BY_NAME.get(name) ?? null;
}

export function toolTier(name: string): ToolTier | null {
  return TOOL_TIERS[name] ?? null;
}

/**
 * May this tool run on this channel, for this role?
 *
 * Unknown tools are denied — a tool with no declared tier is a tool nobody
 * decided the blast radius of. This is the question the harness asks at call
 * time; `buildBelt` asks it (plus the kill switches) at assembly time.
 */
export function isToolAllowed(name: string, channel: Channel, role: ActorRole = "member"): boolean {
  const tier = toolTier(name);
  if (tier == null) return false;
  const spec = toolSpec(name);
  if (spec?.channels && !spec.channels.includes(channel)) return false;
  return isTierAllowed(tier, channel, role);
}

/** Tools this channel/role could reach, before the runtime kill switches. */
export function toolsForChannel(channel: Channel, role: ActorRole = "member"): ToolSpec[] {
  return TOOL_SPECS.filter((s) => isToolAllowed(s.name, channel, role));
}

/**
 * Assemble one turn's belt: filter by policy, apply the kill switches, wrap
 * every survivor in the harness.
 *
 * Note the ordering — the policy filter runs before `enabled`, so a kill
 * switch is never consulted for a tool that was never on this channel anyway,
 * and an unreachable settings table can't accidentally widen the belt.
 */
export async function buildBelt(ctx: ToolContext): Promise<ToolSet> {
  const role: ActorRole = ctx.user?.role ?? "member";
  const belt: ToolSet = {};
  for (const spec of TOOL_SPECS) {
    if (!isToolAllowed(spec.name, ctx.channel, role)) continue;
    if (spec.requiresUser && !ctx.user) continue;
    if (spec.enabled && !(await spec.enabled(ctx))) continue;
    belt[spec.name] = harness(spec, spec.build(ctx), ctx);
  }
  return belt;
}
