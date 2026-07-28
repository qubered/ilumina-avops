import { tool, type Tool } from "ai";
import { z } from "zod";
import { enqueueReview } from "../memory";
import type { ToolContext } from "../tools/harness";
import { DREAM_KINDS, dreamDedupeKey, knownRefs, proposalProblem, type DreamInput, type DreamProposal } from "./proposal";

/**
 * The dream's own tools (MORT_PLAN R7, on `runTurn` as of v2/P6).
 *
 * The dream used to be a single structured call: hand the model a digest of the
 * whole corpus, get a list of proposals back, validate them, queue them. The
 * shape it takes now is the same question asked with the ability to check the
 * answer — Mort can search and read a page (the shared `read` tools are on
 * every channel) before claiming two pages contradict each other, which is the
 * one claim the digest alone can never actually support: a digest has titles,
 * and a contradiction lives in bodies.
 *
 * What is unchanged: a dream NEVER writes. Every question it asks is a
 * judgement call about what the KB should be, which is the user's call, not
 * Mort's — so the channel carries `write:kb` for `raise_proposal` and nothing
 * else, narrowed per tool in the registry rather than by this file being
 * careful. Proposals stay idempotent on the same dedupe key, so a nightly dream
 * re-raises nothing a human already dismissed.
 */

export type DreamTurnState = {
  digest: DreamInput;
  /** Raised this turn, after validation. */
  raised: DreamProposal[];
  /** Seen before — same observation, already in the queue. */
  duplicates: number;
  /** Set by finish_dream. */
  done: boolean;
};

export function newDreamState(digest: DreamInput): DreamTurnState {
  return { digest, raised: [], duplicates: 0, done: false };
}

/** A dream is done when it says so — or when it runs out of steps. */
export const dreamFinished = (ctx: ToolContext): boolean => ctx.dream?.done === true;

const NO_DREAM = "There is no corpus digest in front of you — this tool only means anything on a dream turn.";

export function raiseProposalTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "Raise one observation for a human to decide on. Nothing here is ever written without someone agreeing, so " +
      "say what you actually think — but raise only what genuinely stands out. Every proposal costs a human's " +
      "attention, and a noisy dream gets ignored, which costs you the real ones too.",
    inputSchema: z.object({
      kind: z.enum(DREAM_KINDS),
      title: z.string().describe("Short headline for someone scanning a list, e.g. 'No page covers the SDI floor runs'"),
      rationale: z.string().describe("Two or three sentences: what you noticed, and why it's worth doing something about."),
      sourceIds: z.array(z.string()).describe("sourceIds from the library list this concerns — copied verbatim. Empty if none."),
      docIds: z.array(z.string()).describe("mortIds from the pages list this concerns — copied verbatim. Empty if none."),
      confidence: z.number().min(0).max(1).describe("0-1, how sure you are this is real and worth a human's time."),
    }),
    execute: async (p): Promise<Record<string, unknown>> => {
      const state = ctx.dream;
      if (!state) return { error: NO_DREAM };

      // The invented-reference guard, same as the decision path: a proposal
      // pointing at a file or page that doesn't exist wastes the reader's time
      // working out that it's wrong, and quietly teaches them to distrust the
      // rest. Refused here rather than filtered afterwards, so Mort finds out
      // he got a reference wrong and can raise a corrected one — the batch
      // filter dropped it silently and he never knew.
      const problem = proposalProblem(p, knownRefs(state.digest));
      if (problem) return { error: problem };

      const isNew = await enqueueReview({
        action: `DREAM:${p.kind}`,
        sourceId: p.sourceIds[0] ?? null,
        mortId: p.docIds[0] ?? null,
        rationale: p.rationale,
        payload: { title: p.title, sourceIds: p.sourceIds, docIds: p.docIds, confidence: p.confidence },
        dedupeKey: dreamDedupeKey(p),
      });
      if (!isNew) {
        state.duplicates++;
        return { status: "already_known", note: "You've raised this before and it's still in the queue. Move on." };
      }
      state.raised.push(p);
      return { status: "raised", note: "Queued for a human. Nothing has been written." };
    },
  });
}

export function finishDreamTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "You've looked at everything worth looking at. Call this to end the dream. Raising nothing is a good answer " +
      "and a much better one than a list of maybes.",
    inputSchema: z.object({ summary: z.string().describe("One line on what you looked at and what you made of it.") }),
    execute: async ({ summary }): Promise<Record<string, unknown>> => {
      if (!ctx.dream) return { error: NO_DREAM };
      ctx.dream.done = true;
      return { status: "done", summary };
    },
  });
}
