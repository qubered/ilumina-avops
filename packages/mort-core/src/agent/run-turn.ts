import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { MORT_AUTHORING_PREAMBLE } from "../identity";
import { getMaxSteps } from "../memory/config";
import { spendRail, type SpendRail, type SpendStatus } from "../memory/spend";
import { getChatStack, systemPromptOptions } from "../model/chat";
import { getModel as getIngestModel, modelLabel } from "../model/ingest";
import { buildBelt } from "../tools/registry";
import type { ToolContext } from "../tools/harness";
import { actorLabelOf } from "../tools/harness";
import type { Channel } from "../tools/types";
import { buildSystemPrompt, chatCanWriteKb } from "./prompt";
import type { ActingUser } from "./pending-actions";

/**
 * One Mort turn (MORT_V2_PLAN I.2).
 *
 * v1 had two agents that happened to share a name: a chat agent with a
 * read-only belt, and an authoring pipeline with no belt at all. v2 has one
 * entry point, and everything that distinguishes a chat turn from an ingest
 * turn is data — the channel, the actor, the tier policy that follows from
 * them, the step cap, the budget.
 *
 * Two doors, because chat streams and the machine channels don't:
 *
 *  - `prepareTurn` decides everything that happens BEFORE a model is called —
 *    the belt, the prompt, the step cap, the rail — and hands it back. The
 *    assistant uses this so it can keep its resumable-stream plumbing.
 *  - `runTurn` is the whole turn, non-streaming: prepare, run the loop, meter
 *    what it cost. The job worker uses this.
 *
 * P6 moves ingestion onto `runTurn` proper (classify stays deterministic;
 * understand/gather/decide become agent reasoning over this same belt). What
 * P4 lands is the harness that makes that safe to do: the ingest channel's
 * policy, step cap and spend accounting are enforced here now, so P6 is a
 * change of prompt rather than a change of trust model.
 */

export type TurnEntry =
  | { kind: "chat"; messages: ModelMessage[] }
  /** A file turn. The prompt is the caller's — the belt and the policy are not. */
  | { kind: "ingest"; prompt: string; sourceId?: string }
  | { kind: "dream"; prompt: string };

export type TurnContext = {
  channel: Channel;
  /**
   * Attribution source. A session user on chat; the literal `"system"` on the
   * machine channels. NEVER model-supplied — that is the whole point of it
   * being a parameter of the turn rather than an argument of a tool.
   */
  actor: ActingUser | "system";
  conversationId?: string | null;
  /** The user message this turn answers — a taught fact's provenance (P2). */
  messageId?: string | null;
  /** Re-index hook for a page a confirmed card writes. */
  onWritten?: (docId: string) => Promise<void>;
  /** Override the model. Defaults to the channel's configured provider. */
  model?: LanguageModel;
};

/** Everything the harness settled before the model was called. */
export type TurnPlan = {
  channel: Channel;
  tools: ToolSet;
  /** Ready to spread into streamText/generateText — provider-correct. */
  systemOptions: ReturnType<typeof systemPromptOptions>;
  system: string;
  maxSteps: number;
  spend: SpendRail;
  /** What the belt was built against — handed back so callers can inspect it. */
  toolContext: ToolContext;
  /**
   * Set when the channel's spend cap says this turn should not run at all.
   * Only ever set on the autonomous channels; see memory/spend.ts.
   */
  blocked: { reason: string; status: SpendStatus } | null;
};

export type TurnResult = {
  text: string;
  /** Total tokens, already recorded against the rail. */
  tokens: number;
  steps: number;
  /** Set when the turn never ran (spend cap). */
  blocked: string | null;
};

const actingUser = (actor: TurnContext["actor"]): ActingUser | null => (actor === "system" ? null : actor);

/**
 * The system prompt for a channel.
 *
 * Chat gets the persona and the voice; the machine channels get the authoring
 * preamble and nothing else. That split is deliberate and predates v2 — a
 * procedure page written in Mort's chat register would be worse documentation,
 * and it would outlive every conversation it was charming in.
 */
async function systemFor(entry: TurnEntry): Promise<string> {
  if (entry.kind === "chat") return buildSystemPrompt({ canWriteKb: await chatCanWriteKb() });
  return MORT_AUTHORING_PREAMBLE;
}

async function modelFor(ctx: TurnContext): Promise<LanguageModel> {
  if (ctx.model) return ctx.model;
  if (ctx.channel === "chat") return (await getChatStack()).model;
  return getIngestModel();
}

/**
 * Settle the turn: belt, prompt, step cap, rail. No model is called.
 *
 * The order matters — the belt is assembled against the channel and the
 * actor's role BEFORE any prompt exists, so what Mort can do this turn is
 * never a function of what the turn says.
 */
export async function prepareTurn(entry: TurnEntry, ctx: TurnContext): Promise<TurnPlan> {
  const user = actingUser(ctx.actor);
  const toolContext: ToolContext = {
    channel: ctx.channel,
    user,
    conversationId: ctx.conversationId ?? null,
    messageId: ctx.messageId ?? null,
    seen: new Set<string>(),
    onWritten: ctx.onWritten,
  };

  const rail = spendRail({
    channel: ctx.channel,
    actor: actorLabelOf(toolContext),
    conversationId: ctx.conversationId ?? null,
  });

  const [tools, system, maxSteps, exceeded] = await Promise.all([
    buildBelt(toolContext),
    systemFor(entry),
    getMaxSteps(ctx.channel),
    rail.exceeded(),
  ]);

  return {
    channel: ctx.channel,
    tools,
    system,
    systemOptions: systemPromptOptions(system),
    maxSteps,
    spend: rail,
    toolContext,
    blocked: exceeded
      ? {
          reason: `Mort has reached today's token cap — the ${ctx.channel} channel is paused until tomorrow.`,
          status: await rail.status(),
        }
      : null,
  };
}

/**
 * Run a whole turn, non-streaming.
 *
 * Chat callers that need to stream use `prepareTurn` and drive `streamText`
 * themselves; everything the harness decides is in the plan, so the two paths
 * cannot drift on policy — only on how the bytes reach the caller.
 */
export async function runTurn(entry: TurnEntry, ctx: TurnContext): Promise<TurnResult> {
  const plan = await prepareTurn(entry, ctx);
  if (plan.blocked) {
    console.warn(`[mort] ${ctx.channel} turn not started: ${plan.blocked.reason}`);
    return { text: "", tokens: 0, steps: 0, blocked: plan.blocked.reason };
  }

  const messages: ModelMessage[] =
    entry.kind === "chat" ? entry.messages : [{ role: "user", content: entry.prompt }];

  const result = await generateText({
    model: await modelFor(ctx),
    ...plan.systemOptions,
    messages,
    tools: plan.tools,
    stopWhen: stepCountIs(plan.maxSteps),
  });

  const tokens = result.totalUsage?.totalTokens ?? 0;
  // Metered even when the turn produced nothing useful: the rail is about what
  // was spent, not what was gained.
  await plan.spend.record(tokens, { model: ctx.channel === "chat" ? null : modelLabel() });

  return { text: result.text, tokens, steps: result.steps.length, blocked: null };
}
