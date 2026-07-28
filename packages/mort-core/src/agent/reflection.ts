import { z } from "zod";
import type { Lesson, LessonEvidence } from "../memory/lessons";
import type { ReflectionSignals } from "../memory/signals";

/**
 * The shape, validity and turn state of a reflection (MORT_V2_PLAN I.6,
 * decision V2-4). Pure — no env, no model, no database — so the rules that
 * decide what may become a lesson are testable on their own.
 *
 * The reflection is the dream's second phase, and it is deliberately built the
 * same way the first one is: a bounded turn, a tool that validates before it
 * writes, and an invented-reference guard. A lesson claiming to come from
 * journal row 918 when nothing in this window is row 918 is exactly as
 * corrosive as a proposal about a page that doesn't exist — it reads as
 * evidence, it survives review because checking it is work, and it teaches
 * whoever eventually checks to stop trusting the rest.
 */

/**
 * Scope tags a lesson may carry. The two channel names are meaningful to the
 * prompt injection (agent/lessons-prompt.ts); anything else is a free tag —
 * a zone or a system — that a human reads in the panel.
 *
 * `dream` is deliberately NOT offered. A lesson scoped to the reflection would
 * only ever be read by the reflection, which is a loop that teaches itself and
 * nothing else.
 */
export const LESSON_CHANNEL_SCOPES = ["chat", "ingest"] as const;

export const lessonDraft = z.object({
  lesson: z
    .string()
    .min(10)
    .max(240)
    .describe(
      "ONE imperative sentence you could actually follow next time, e.g. 'Check the event log before answering “what's it set to now”'. Not an observation, not a summary.",
    ),
  detail: z
    .string()
    .max(600)
    .nullish()
    .describe("Optional: a sentence or two on what went wrong and why this is the fix."),
  scope: z
    .array(z.string().min(1).max(40))
    .max(6)
    .describe(
      "Where this applies: 'chat', 'ingest', and/or zone/system tags like 'Main Stage' or 'Lighting'. Leave EMPTY only when it genuinely applies to everything you do.",
    ),
  evidence: z
    .array(
      z.object({
        kind: z.enum(["journal", "feedback", "review"]),
        id: z.string().describe("The id from the signal list, copied verbatim."),
        note: z.string().max(200).nullish().describe("What that row showed, in a few words."),
      }),
    )
    .min(1)
    .max(6)
    .describe("The rows that made you think this. At least one, copied verbatim from the lists you were shown."),
});

export type LessonDraft = z.infer<typeof lessonDraft>;

/** Everything a reflection turn is given: the window's signals and what Mort already believes. */
export type ReflectionInput = {
  signals: ReflectionSignals;
  /** Active lessons, so the turn dedupes against them rather than restating them. */
  existing: Lesson[];
};

export type ReflectTurnState = {
  input: ReflectionInput;
  /** Filed this turn, after validation. */
  learned: Lesson[];
  /** Already known — same thought, active or previously retired. */
  duplicates: number;
  /** Set by finish_reflection. */
  done: boolean;
};

export function newReflectState(input: ReflectionInput): ReflectTurnState {
  return { input, learned: [], duplicates: 0, done: false };
}

/** The ids a lesson may cite, from the window it was shown. */
export function knownSignalIds(signals: ReflectionSignals): Record<LessonEvidence["kind"], Set<string>> {
  return {
    journal: new Set(signals.journal.map((j) => String(j.id))),
    review: new Set(signals.reviews.map((r) => String(r.id))),
    feedback: new Set(signals.feedback.map((f) => f.id)),
  };
}

/**
 * Why a draft can't become a lesson, or null if it can.
 *
 * Returned as a sentence rather than a boolean for the same reason
 * `proposalProblem` is: the caller is a tool, so Mort finds out what he got
 * wrong and can file a corrected one. A silent drop teaches him nothing, which
 * would be a strange way to build the feature whose entire purpose is learning.
 */
export function lessonProblem(
  draft: Pick<LessonDraft, "lesson" | "evidence">,
  known: Record<LessonEvidence["kind"], Set<string>>,
): string | null {
  const ghost = draft.evidence.find((e) => !known[e.kind].has(String(e.id)));
  if (ghost) {
    return `There is no ${ghost.kind} row '${ghost.id}' in what you were shown. Copy ids verbatim from the lists — don't reconstruct them.`;
  }
  // A lesson you can't act on is a mood. The cheap tells are the ones worth
  // catching here; the rest is the instructions' job.
  if (!/[a-z]/i.test(draft.lesson)) return "A lesson has to be a sentence.";
  if (draft.lesson.includes("\n")) {
    return "One sentence, one line. If it needs two thoughts, it's two lessons — or it belongs in `detail`.";
  }
  return null;
}

/** A reflection is done when it says so — or when it runs out of steps. */
export const reflectionFinished = (state: ReflectTurnState | undefined): boolean => state?.done === true;
