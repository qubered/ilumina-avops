import type { Tool, ToolSet } from "ai";
import type { ChatToolContext } from "../agent/cards";
import {
  buildKbGetDocTool,
  buildKbSearchTool,
  currentStateTool,
  eventLogTool,
  mortLessonsTool,
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
import {
  attachToPageTool,
  createPageTool,
  holdFileTool,
  noteUnderstandingTool,
  sendToReviewTool,
  skipFileTool,
  updatePageTool,
} from "../agent/ingest-tools";
import { finishDreamTool, raiseProposalTool } from "../agent/dream-tools";
import { finishReflectionTool, noteLessonTool } from "../agent/reflect-tools";
import { buildMcpAdminTools, buildMcpTools, mcpTools } from "../mcp";
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
  // "What have you learnt lately?" (P7). On every channel: it is the reflection's
  // own way of checking what it already holds before concluding it again.
  { name: "mort_lessons", tier: "read", build: () => mortLessonsTool },
  { name: "list_pending", tier: "read", requiresUser: true, build: (ctx) => listPendingTool(chatCtx(ctx)) },
  { name: "confirm_pending", tier: "read", requiresUser: true, build: (ctx) => confirmPendingTool(chatCtx(ctx)) },

  // --- write:memory — Mort's own state, cheap to reverse, confirm-first ----
  //
  // Narrowed to `chat` explicitly, not incidentally. The dream channel carries
  // the write:memory tier for `note_lesson` alone (P7), and these three must be
  // unreachable there for a reason that predates it: a fact is only
  // authoritative because a named human approved it, and there is nobody on a
  // machine channel to be that human. `requiresUser` would also stop them; this
  // says so in the one place the belt is decided.
  {
    name: "save_fact",
    tier: "write:memory",
    channels: ["chat"],
    requiresUser: true,
    build: (ctx) => saveFactTool(chatCtx(ctx)),
  },
  {
    name: "retire_fact",
    tier: "write:memory",
    channels: ["chat"],
    requiresUser: true,
    build: (ctx) => retireFactTool(chatCtx(ctx)),
  },
  {
    name: "log_event",
    tier: "write:memory",
    channels: ["chat"],
    requiresUser: true,
    build: (ctx) => logEventTool(chatCtx(ctx)),
  },

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

  // --- the authoring turn (P6) ---------------------------------------------
  //
  // Named apart from chat's create_doc / propose_doc_edit / attach_source
  // deliberately. Same tier, same routing through resolveKbWriteRoute — but
  // chat's park a card for a person to confirm and these execute under the
  // gates, because there is no person on this channel. One name for two
  // behaviours would be the worse lie.
  //
  // `channels: ["ingest"]` is doing real work here, not documentation: it is
  // what stops a conversation reaching a tool that writes without a card.
  { name: "note_understanding", tier: "read", channels: ["ingest"], build: noteUnderstandingTool },
  // hold_file and skip_file are `read` because the tier measures blast radius,
  // not how final the tool sounds: neither touches anything outside the turn.
  { name: "hold_file", tier: "read", channels: ["ingest"], build: holdFileTool },
  { name: "skip_file", tier: "read", channels: ["ingest"], build: skipFileTool },
  { name: "create_page", tier: "write:kb", channels: ["ingest"], build: createPageTool },
  { name: "update_page", tier: "write:kb", channels: ["ingest"], build: updatePageTool },
  { name: "attach_to_page", tier: "write:kb", channels: ["ingest"], build: attachToPageTool },
  { name: "send_to_review", tier: "write:kb", channels: ["ingest"], build: sendToReviewTool },

  // --- the dream (P6) -------------------------------------------------------
  //
  // The whole write:kb tier the dream channel has, and it only reaches the
  // review queue. R7's rule — a dream proposes, a human decides — enforced by
  // there being nothing else on the channel to reach for.
  // The `enabled` predicates split the dream channel's two phases (P7). Both
  // run on this channel, but a corpus turn has no signals and a reflection turn
  // has no digest — so a tool from the other phase could only ever refuse
  // itself, and a model offered a tool that always refuses will spend a step
  // finding that out. The per-turn state on the ToolContext is set by
  // prepareTurn from the entry, never by a tool, so this cannot be steered from
  // inside a turn.
  {
    name: "raise_proposal",
    tier: "write:kb",
    channels: ["dream"],
    enabled: async (ctx) => ctx.dream != null,
    build: raiseProposalTool,
  },
  {
    name: "finish_dream",
    tier: "read",
    channels: ["dream"],
    enabled: async (ctx) => ctx.dream != null,
    build: finishDreamTool,
  },

  // --- the reflection (P7) --------------------------------------------------
  //
  // The dream's second phase, and the only write:memory tool that exists off
  // the chat channel. It writes ONE kind of row — a lesson about how Mort
  // works — which is live immediately, visible in the admin panel and retirable
  // with one click. That combination is why it needs no confirmation card: the
  // cost of a wrong lesson is bounded by how easily a human can delete it, and
  // there is deliberately no tool that lets Mort retire one himself.
  {
    name: "note_lesson",
    tier: "write:memory",
    channels: ["dream"],
    enabled: async (ctx) => ctx.reflect != null,
    build: noteLessonTool,
  },
  {
    name: "finish_reflection",
    tier: "read",
    channels: ["dream"],
    enabled: async (ctx) => ctx.reflect != null,
    build: finishReflectionTool,
  },

  // --- admin — the console, in chat form (P5) ------------------------------
  //
  // Not "things Mort decides", things an admin does through Mort because a
  // conversation is a faster console than the console. Built as a pair by
  // buildMcpAdminTools and picked apart here so each is a registered tool with
  // its own row in the tier table.
  {
    name: "mcp_servers",
    tier: "admin",
    requiresUser: true,
    build: (ctx) => buildMcpAdminTools(chatCtx(ctx)).mcp_servers,
  },
  {
    name: "mcp_toggle",
    tier: "admin",
    requiresUser: true,
    build: (ctx) => buildMcpAdminTools(chatCtx(ctx)).mcp_toggle,
  },
];

const BY_NAME = new Map(TOOL_SPECS.map((s) => [s.name, s]));

/**
 * Tools that carry a tier but never appear on a belt, because they only exist
 * as a parked card:
 *
 * - `apply_doc_edit` is the parked form of a propose_doc_edit.
 * - `mcp_call` is the parked form of ANY MCP tool — every call parks under
 *   this one name whatever the server called it, so the card, the confirm
 *   route and the executor all have a fixed name whose tier they can check.
 *
 * Declared here so the one table of tiers stays complete, and cross-checked
 * against `pendingToolTier` by the registry's test.
 */
export const CARD_ONLY_TIERS: Record<string, ToolTier> = {
  apply_doc_edit: "write:kb",
  mcp_call: "write:world",
};

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
  for (const [name, spec, built] of await discoveredTools(ctx, role)) {
    belt[name] = harness(spec, built, ctx);
  }
  return belt;
}

/**
 * The MCP half of the belt (P5), wrapped by the same harness as everything
 * else.
 *
 * These can't be `TOOL_SPECS` entries: a connected server's tools are
 * discovered at runtime and their tiers come from the server's registry row,
 * so the spec is synthesised per tool per turn. `buildMcpTools` has already
 * applied its own gating (role, reachability, the `mcp` master switch) — the
 * harness adds what it doesn't do, which is the uniform `mort_tool_calls` row
 * and the call-time tier re-check.
 */
async function discoveredTools(
  ctx: ToolContext,
  role: ActorRole,
): Promise<Array<[string, ToolSpec, ToolSet[string]]>> {
  if (ctx.channel !== "chat" || !ctx.user) return [];
  const built = await buildMcpTools(chatCtx(ctx), ctx.channel);
  if (Object.keys(built).length === 0) return [];

  const tiers = new Map(mcpTools().map((t) => [t.name, t.tier]));
  const out: Array<[string, ToolSpec, ToolSet[string]]> = [];
  for (const [name, tool] of Object.entries(built)) {
    // A tool the manager no longer knows the tier of is treated as write:world
    // — the most cautious answer, and the same default a server's tools get
    // before an admin has said anything about them.
    const tier = tiers.get(name) ?? "write:world";
    if (!isTierAllowed(tier, ctx.channel, role)) continue;
    out.push([name, { name, tier, channels: ["chat"], requiresUser: true, build: () => tool }, tool]);
  }
  return out;
}
