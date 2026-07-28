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
import { buildSystemPrompt, chatCanWriteKb, chatHasAdminTools, chatHasMcpTools } from "./prompt";
import type { Surface } from "../tools/types";
import type { ActingUser } from "./pending-actions";
import {
  hasDecided,
  newIngestState,
  type IngestDecision,
  type IngestDeps,
  type IngestFile,
  type IngestUnderstanding,
} from "./ingest-tools";
import { dreamFinished, newDreamState } from "./dream-tools";
import type { DreamInput, DreamProposal } from "./proposal";
import { newReflectState, reflectionFinished, type ReflectionInput } from "./reflection";
import type { Lesson } from "../memory/lessons";
import { buildLessonsSection } from "./lessons-prompt";
import {
  DREAM_INSTRUCTIONS,
  dreamPrompt,
  INGEST_INSTRUCTIONS,
  ingestPrompt,
  REFLECTION_INSTRUCTIONS,
  reflectionPrompt,
} from "./authoring-prompt";

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
 * P6 finishes the job: ingestion and the dream run here now. `classify` stays
 * deterministic pre-processing; understand/gather/decide become agent reasoning
 * over this same belt, and the dream gains the ability to read a page before
 * claiming two of them contradict each other. Because P4 had already put the
 * ingest channel's policy, step cap and spend accounting in this file, that was
 * a change of prompt and tools rather than a change of trust model — which is
 * why `runIngestTurn` below is thirty lines and not three hundred.
 *
 * The two machine entries carry their turn state (the file and the decision so
 * far; the digest and what has been raised) onto the ToolContext, where the
 * tools read it. It is set here, from the entry, and never by a tool.
 */

export type TurnEntry =
  | { kind: "chat"; messages: ModelMessage[] }
  /** A file turn (P6). The prompt is derived from the file, not supplied. */
  | { kind: "ingest"; file: IngestFile; deps: IngestDeps }
  /** The nightly look over the whole corpus (P6). */
  | { kind: "dream"; digest: DreamInput }
  /** The nightly look over Mort's own record — the dream's second phase (P7). */
  | { kind: "reflect"; input: ReflectionInput };

export type TurnContext = {
  channel: Channel;
  /**
   * Which chat surface this turn is being had on (P8). Set by the route from
   * how the request arrived — never from the message, since a widget claiming
   * to be the full app would be claiming a wider belt. Absent means the full
   * app, which is what the machine channels want and what every caller before
   * P8 meant.
   */
  surface?: Surface;
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
  /**
   * The context the belt ran against. A machine turn's outcome lives on it —
   * the decision an ingest turn reached, the proposals a dream raised — because
   * the tools record what they did rather than the loop guessing from the text.
   */
  toolContext: ToolContext;
};

const actingUser = (actor: TurnContext["actor"]): ActingUser | null => (actor === "system" ? null : actor);

/**
 * The system prompt for a channel.
 *
 * Chat gets the persona and the voice; the machine channels get the authoring
 * preamble and nothing else. That split is deliberate and predates v2 — a
 * procedure page written in Mort's chat register would be worse documentation,
 * and it would outlive every conversation it was charming in.
 *
 * Takes the belt that was actually built rather than recomputing what it
 * should contain: describing a tool the model doesn't have is how a model
 * comes to invent one, and "should contain" and "contains" diverge for real
 * reasons — an admin whose only enabled MCP server is unreachable gets no
 * connected tools this turn.
 */
async function systemFor(entry: TurnEntry, tools: ToolSet, ctx: TurnContext): Promise<string> {
  // Lessons sit between who Mort is and the rules he works under, on both
  // channels that do real work (P7). The reflection itself gets none: a turn
  // whose job is to judge its own lessons should not be reading them back as
  // instructions, and it is handed the active list as DATA in its prompt
  // instead, to dedupe against.
  if (entry.kind === "ingest") {
    return [MORT_AUTHORING_PREAMBLE, await buildLessonsSection("ingest"), INGEST_INSTRUCTIONS]
      .filter(Boolean)
      .join("\n\n");
  }
  if (entry.kind === "dream") return `${MORT_AUTHORING_PREAMBLE}\n\n${DREAM_INSTRUCTIONS}`;
  if (entry.kind === "reflect") return `${MORT_AUTHORING_PREAMBLE}\n\n${REFLECTION_INSTRUCTIONS}`;
  return buildSystemPrompt({
    canWriteKb: chatCanWriteKb(tools),
    hasMcpTools: chatHasMcpTools(tools),
    hasAdminTools: chatHasAdminTools(tools),
    lessons: await buildLessonsSection("chat"),
    surface: ctx.surface,
  });
}

/** The turn's opening message: the file, the corpus digest, or the week's signals. */
function promptFor(entry: TurnEntry): string {
  if (entry.kind === "ingest") return ingestPrompt(entry.file);
  if (entry.kind === "dream") return dreamPrompt(entry.digest);
  if (entry.kind === "reflect") return reflectionPrompt(entry.input);
  return "";
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
    surface: ctx.surface,
    user,
    conversationId: ctx.conversationId ?? null,
    messageId: ctx.messageId ?? null,
    seen: new Set<string>(),
    onWritten: ctx.onWritten,
    // The machine channels' turn state, built from the entry. A tool never
    // creates this — it reads it — so what a turn is about cannot be changed
    // from inside the turn.
    ingest: entry.kind === "ingest" ? newIngestState(entry.file, entry.deps) : undefined,
    dream: entry.kind === "dream" ? newDreamState(entry.digest) : undefined,
    reflect: entry.kind === "reflect" ? newReflectState(entry.input) : undefined,
  };

  const rail = spendRail({
    channel: ctx.channel,
    actor: actorLabelOf(toolContext),
    conversationId: ctx.conversationId ?? null,
  });

  // The belt first, then the prompt from it — see systemFor. Everything else
  // is independent of both.
  const [tools, maxSteps, exceeded] = await Promise.all([
    buildBelt(toolContext),
    getMaxSteps(ctx.channel),
    rail.exceeded(),
  ]);
  const system = await systemFor(entry, tools, ctx);

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
    return { text: "", tokens: 0, steps: 0, blocked: plan.blocked.reason, toolContext: plan.toolContext };
  }

  const messages: ModelMessage[] =
    entry.kind === "chat" ? entry.messages : [{ role: "user", content: promptFor(entry) }];

  const result = await generateText({
    model: await modelFor(ctx),
    ...plan.systemOptions,
    messages,
    tools: plan.tools,
    // Two stops on the machine channels, and both matter. The first is the
    // normal ending — the turn has reached its end state, and letting the model
    // keep going after that is how you get a second decision. It checks the
    // STATE rather than "was a terminal tool called", because a terminal tool
    // can be refused (deciding before understanding, deciding twice) and a
    // refusal must leave the turn alive to correct itself. The step count is
    // the rail: it bounds a turn that is looping, hedging, or being argued with
    // by the document it is reading.
    stopWhen:
      entry.kind === "chat"
        ? stepCountIs(plan.maxSteps)
        : [stepCountIs(plan.maxSteps), () => isDone(entry, plan.toolContext)],
  });

  const tokens = result.totalUsage?.totalTokens ?? 0;
  // Metered even when the turn produced nothing useful: the rail is about what
  // was spent, not what was gained.
  await plan.spend.record(tokens, { model: ctx.channel === "chat" ? null : modelLabel() });

  return { text: result.text, tokens, steps: result.steps.length, blocked: null, toolContext: plan.toolContext };
}

/** Has a machine turn reached its end state? */
function isDone(entry: TurnEntry, ctx: ToolContext): boolean {
  if (entry.kind === "ingest") return hasDecided(ctx);
  if (entry.kind === "dream") return dreamFinished(ctx);
  if (entry.kind === "reflect") return reflectionFinished(ctx.reflect);
  return false;
}

// --- the machine channels, typed (P6) ---------------------------------------

export type IngestTurnResult = {
  decision: IngestDecision;
  understanding: IngestUnderstanding | null;
  tokens: number;
  steps: number;
  blocked: string | null;
};

/**
 * One file, one decision.
 *
 * The fallback when nothing was decided is a HOLD, not a guess. The file stays
 * in the library and is re-checked whenever a page it might belong on appears,
 * so the cost of holding is a delay — where the cost of guessing is a wrong
 * page that reads as authoritative. Same for a turn the spend cap stopped: it
 * has spent nothing and decided nothing, and the queue will bring the file back
 * tomorrow.
 */
export async function runIngestTurn(
  file: IngestFile,
  deps: IngestDeps,
  ctx: Omit<TurnContext, "channel" | "actor"> & { actor?: TurnContext["actor"] } = {},
): Promise<IngestTurnResult> {
  const result = await runTurn(
    { kind: "ingest", file, deps },
    { ...ctx, channel: "ingest", actor: ctx.actor ?? "system" },
  );
  const state = result.toolContext.ingest;
  const decision: IngestDecision = state?.decision ?? {
    action: "HOLD",
    executed: "held",
    rationale: result.blocked ?? `no decision within ${result.steps} step(s) — held for the next re-check`,
    confidence: null,
  };
  return {
    decision,
    understanding: state?.understanding ?? null,
    tokens: result.tokens,
    steps: result.steps,
    blocked: result.blocked,
  };
}

export type DreamTurnResult = {
  raised: DreamProposal[];
  /** Observations Mort had already raised and that are still in the queue. */
  duplicates: number;
  tokens: number;
  steps: number;
  blocked: string | null;
};

export async function runDreamTurn(
  digest: DreamInput,
  ctx: Omit<TurnContext, "channel" | "actor"> & { actor?: TurnContext["actor"] } = {},
): Promise<DreamTurnResult> {
  const result = await runTurn({ kind: "dream", digest }, { ...ctx, channel: "dream", actor: ctx.actor ?? "system" });
  const state = result.toolContext.dream;
  return {
    raised: state?.raised ?? [],
    duplicates: state?.duplicates ?? 0,
    tokens: result.tokens,
    steps: result.steps,
    blocked: result.blocked,
  };
}

export type ReflectTurnResult = {
  /** Filed this turn — active immediately, and in the next prompt. */
  learned: Lesson[];
  /** Conclusions Mort already held, or that a human has already retired. */
  duplicates: number;
  tokens: number;
  steps: number;
  blocked: string | null;
};

/**
 * The dream's second phase: look at the record of what Mort did and how it
 * landed, and write down what to do differently (P7).
 *
 * Runs on the `dream` channel, so it inherits that channel's whole trust model
 * unchanged — no pen over the KB, no facts, no reach beyond Mort's systems —
 * and adds exactly one capability: `note_lesson`, narrowed to this channel in
 * the registry. Learning nothing is a normal outcome and produces an empty
 * list, not a failure.
 */
export async function runReflectionTurn(
  input: ReflectionInput,
  ctx: Omit<TurnContext, "channel" | "actor"> & { actor?: TurnContext["actor"] } = {},
): Promise<ReflectTurnResult> {
  const result = await runTurn({ kind: "reflect", input }, { ...ctx, channel: "dream", actor: ctx.actor ?? "system" });
  const state = result.toolContext.reflect;
  return {
    learned: state?.learned ?? [],
    duplicates: state?.duplicates ?? 0,
    tokens: result.tokens,
    steps: result.steps,
    blocked: result.blocked,
  };
}
