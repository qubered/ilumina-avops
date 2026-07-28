import type { Tool } from "ai";
import { recordToolCall, type ToolOutcome } from "../memory/tool-journal";
import type { ActingUser } from "../agent/pending-actions";
import { isTierAllowed, tierNeedsConfirmation } from "./policy";
import type { ActorRole, Channel } from "./types";
// Type-only: the registry imports this module, so importing it back for a
// value would close the loop at module-eval time. Same for the two machine
// channels' turn state.
import type { ToolSpec } from "./registry";
import type { IngestTurnState } from "../agent/ingest-tools";
import type { DreamTurnState } from "../agent/dream-tools";

/**
 * The harness (MORT_V2_PLAN I.2, decision V2-5).
 *
 * Everything a tool call passes through on its way in and out: the policy
 * re-check, the clock, and the audit row. Wrapping happens in the registry, so
 * a tool cannot reach a belt without going through here — which is the whole
 * design. v1's guards lived inside individual tools and in the ingest turn,
 * which meant every new tool started with none of them.
 *
 * Two things this deliberately does NOT do. It does not decide what a
 * particular payload should become (`resolveKbWriteRoute` does that, per call,
 * inside the write tools — role, mode and confidence are payload questions).
 * And it does not sanitise arguments: the tools' own Zod schemas already
 * reject anything malformed, and a second opinion here would only be a second
 * place for the two to disagree.
 */

/** Everything a turn's tools are built and judged against. */
export type ToolContext = {
  channel: Channel;
  /** From the session on chat; null on the machine channels. NEVER model-supplied. */
  user: ActingUser | null;
  conversationId: string | null;
  /** The user message this turn is answering — a taught fact's provenance (P2). */
  messageId?: string | null;
  /** Outline doc ids Mort has actually seen this turn — the invented-target guard. */
  seen: Set<string>;
  /** Re-index hook for a page a confirmed card just wrote. */
  onWritten?: (docId: string) => Promise<void>;
  /**
   * The machine channels' per-turn state (P6). Set by `prepareTurn` from the
   * entry, never by a tool: `ingest` is the file being decided about and the
   * decision reached so far, `dream` is the corpus digest and what's been
   * raised. A chat turn has neither, and the tools that read them are narrowed
   * to their channel in the registry, so "the state is missing" is a bug rather
   * than a routine case.
   */
  ingest?: IngestTurnState;
  dream?: DreamTurnState;
};

/** How an actor is named in the audit log. */
export function actorLabelOf(ctx: ToolContext): string {
  return ctx.user ? ctx.user.email || ctx.user.name || ctx.user.id : "system";
}

const roleOf = (ctx: ToolContext): ActorRole => ctx.user?.role ?? "member";

/**
 * Why this call may not proceed, or null if it may.
 *
 * Re-checking what `buildBelt` already checked is not redundancy for its own
 * sake: a belt is assembled once at the top of a turn and a turn can run for
 * a minute, during which an admin may flip the mode or pull the kill switch.
 * It also means a tool reaching a belt by any route other than `buildBelt` —
 * a future MCP merge, a test, a mistake — is still policed.
 */
async function refusalReason(spec: ToolSpec, ctx: ToolContext): Promise<string | null> {
  if (spec.channels && !spec.channels.includes(ctx.channel)) {
    return `${spec.name} is not available on the ${ctx.channel} channel.`;
  }
  if (!isTierAllowed(spec.tier, ctx.channel, roleOf(ctx))) {
    return `${spec.name} is a ${spec.tier} tool and the ${ctx.channel} channel does not permit that${
      ctx.user ? ` for a ${roleOf(ctx)}` : ""
    }. Nothing was done.`;
  }
  if (spec.requiresUser && !ctx.user) {
    return `${spec.name} writes on a named person's behalf and this turn has no acting user. Nothing was done.`;
  }
  if (tierNeedsConfirmation(spec.tier) && !ctx.user) {
    return `${spec.name} reaches beyond Mort's own systems and needs a person to confirm it. Nothing was done.`;
  }
  if (spec.enabled && !(await spec.enabled(ctx))) {
    return `${spec.name} is switched off right now. Nothing was done, and say so rather than claiming otherwise.`;
  }
  return null;
}

/**
 * Did the call work? The tools here return `{ error }` or `{ status:
 * "blocked" }` rather than throwing — a KB outage or a refused MCP call should
 * reach the model as a result it can explain, not kill the stream — so a plain
 * thrown/returned split would record most real failures, and every policy
 * refusal a tool made for itself, as successes.
 */
function outcomeOf(result: unknown): { outcome: ToolOutcome; detail: string | null } {
  if (!result || typeof result !== "object") return { outcome: "ok", detail: null };
  // A tool that refused itself — `resolveKbWriteRoute`/`resolveMcpCall` said no
  // inside the executor. Same outcome as a harness refusal, because from an
  // auditor's point of view it is the same event.
  if ((result as { status?: unknown }).status === "blocked") {
    const reason = (result as { reason?: unknown }).reason;
    return { outcome: "refused", detail: typeof reason === "string" ? reason : "blocked by policy" };
  }
  if ("error" in result) {
    const e = (result as { error: unknown }).error;
    return { outcome: "error", detail: typeof e === "string" ? e : "tool reported an error" };
  }
  return { outcome: "ok", detail: null };
}

/**
 * Wrap one built tool. The returned tool is the original with its executor
 * fronted — same name, same description, same schema, so the model sees no
 * difference and nothing about the prompt changes.
 */
export function harness(spec: ToolSpec, built: Tool, ctx: ToolContext): Tool {
  const inner = built.execute;
  if (!inner) return built;

  const audit = {
    tool: spec.name,
    tier: spec.tier,
    channel: ctx.channel,
    actor: actorLabelOf(ctx),
    conversationId: ctx.conversationId,
  };

  return {
    ...built,
    execute: async (args: unknown, options: Parameters<NonNullable<Tool["execute"]>>[1]) => {
      const started = Date.now();

      const refusal = await refusalReason(spec, ctx);
      if (refusal) {
        // Logged loudly: on the ingest channel this is the signature of a
        // document trying to talk Mort into writing something, which is the
        // one line in this file the whole injection posture rests on.
        console.warn(`[mort] refused ${spec.name} on the ${ctx.channel} channel: ${refusal}`);
        await recordToolCall({ ...audit, args, outcome: "refused", detail: refusal, latencyMs: Date.now() - started });
        return { error: refusal };
      }

      try {
        const result = await inner(args as never, options);
        const { outcome, detail } = outcomeOf(result);
        await recordToolCall({ ...audit, args, outcome, detail, latencyMs: Date.now() - started });
        return result;
      } catch (err) {
        // A thrown tool is rare (the tools catch their own) and worth recording
        // before it propagates — the turn may well die here, and an audit trail
        // that stops at the last success is the one you can't debug from.
        await recordToolCall({
          ...audit,
          args,
          outcome: "error",
          detail: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - started,
        });
        throw err;
      }
    },
  } as Tool;
}
