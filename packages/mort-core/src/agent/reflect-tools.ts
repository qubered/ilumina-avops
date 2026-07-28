import { tool, type Tool } from "ai";
import { z } from "zod";
import { recordLesson } from "../memory/lessons";
import type { ToolContext } from "../tools/harness";
import { knownSignalIds, lessonDraft, lessonProblem } from "./reflection";

/**
 * The reflection's own tools (v2/P7, MORT_V2_PLAN I.6).
 *
 * `note_lesson` is the only `write:memory` tool that exists off the chat
 * channel, and the shape of that exception is the point: the registry narrows
 * it to `dream`, so the reflection can write what it concluded about Mort's own
 * behaviour and cannot touch a fact, an event or a page. A lesson is the
 * cheapest thing in the system to reverse — one row, one button, gone from the
 * next prompt — which is why it is the one thing the machine channels get to
 * write without a human first.
 *
 * There is deliberately no `retire_lesson` tool. Retiring is a human's
 * judgement that a lesson is wrong, and an agent that could retire its own
 * lessons could quietly undo yours.
 */

const NO_REFLECTION =
  "There are no signals in front of you — this tool only means anything on a reflection turn.";

export function noteLessonTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "File one lesson you've drawn from your own record. It goes live immediately and into your future prompts, " +
      "fully visible to the crew and retirable by them with one click — so file what you actually believe, and " +
      "nothing you don't. Every lesson costs room in every prompt you get from now on: two real ones beat six " +
      "plausible ones.",
    inputSchema: lessonDraft,
    execute: async (draft): Promise<Record<string, unknown>> => {
      const state = ctx.reflect;
      if (!state) return { error: NO_REFLECTION };

      const problem = lessonProblem(draft, knownSignalIds(state.input.signals));
      if (problem) return { error: problem };

      const { lesson, created } = await recordLesson({
        lesson: draft.lesson,
        detail: draft.detail ?? null,
        scope: draft.scope,
        evidence: draft.evidence.map((e) => ({ kind: e.kind, id: String(e.id), ...(e.note ? { note: e.note } : {}) })),
        origin: "dream",
      });

      if (!created) {
        state.duplicates++;
        // Says which, because the two cases mean different things to a model
        // deciding what to do next: an active duplicate is a thought already
        // working, a retired one is a thought a human has ALREADY rejected and
        // going round again in different words would be arguing with them.
        return {
          status: "already_known",
          note:
            lesson.status === "retired"
              ? "You've concluded this before and someone retired it. Leave it retired and move on."
              : "You already hold this lesson. Move on.",
        };
      }

      state.learned.push(lesson);
      return { status: "learned", lessonId: lesson.id, note: "Active from your next turn, and visible to the crew." };
    },
  });
}

export function finishReflectionTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "You've been through the signals. Call this to end the reflection. Learning nothing is a good answer and a " +
      "much better one than a lesson invented to have written something.",
    inputSchema: z.object({
      summary: z.string().describe("One line on what you looked at and what you made of it."),
    }),
    execute: async ({ summary }): Promise<Record<string, unknown>> => {
      if (!ctx.reflect) return { error: NO_REFLECTION };
      ctx.reflect.done = true;
      return { status: "done", summary };
    },
  });
}
