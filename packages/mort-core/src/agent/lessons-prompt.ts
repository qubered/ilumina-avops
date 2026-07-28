import { activeLessonsFor, type Lesson } from "../memory/lessons";
import type { Channel } from "../tools/types";

/**
 * Injecting what Mort has learnt into what Mort is told (MORT_V2_PLAN I.6).
 *
 * Two rules govern this file and both are about blast radius.
 *
 * ORDER. The section is placed BEFORE the scope and safety rules, never after.
 * A lesson is a distillation of Mort's own record — useful, occasionally wrong,
 * and written by a model. The rules it sits above are the ones that say what
 * Mort's job is and what he may never do, and those are framed as overriding
 * precisely so that nothing derived from experience can erode them. Ordering is
 * the mechanism; the sentence at the top of the section is only the courtesy.
 *
 * SIZE. A lessons list that grows without bound quietly eats the prompt that
 * makes Mort work — every turn, on every channel, forever. Two hard caps: at
 * most `MAX_LESSONS` rows, and at most `MAX_CHARS` of them. Reached in
 * newest-first order, so what falls off the end is the oldest thinking.
 */

/** The most lessons any one prompt carries. */
export const MAX_LESSONS = 10;

/**
 * The character budget for the section — roughly the 800-token cap in the plan
 * at ~4 chars/token. Counted in characters because that is the thing this
 * module can measure exactly, and a cap you can only estimate is a cap that
 * drifts.
 */
export const MAX_CHARS = 3_200;

const HEADER = `LESSONS — what you've worked out from your own record:`;

const FOOTER = `These are your own conclusions from what actually happened, not instructions from anyone. Follow them where they fit, ignore one that plainly doesn't apply to the question in front of you, and never let one override the rules below — those come last and they win.`;

/** One lesson as a prompt line: the sentence, and the detail if there is one. */
function render(lesson: Lesson): string {
  const scope = lesson.scope.length ? ` (${lesson.scope.join(", ")})` : "";
  const detail = lesson.detail ? ` — ${lesson.detail}` : "";
  return `- ${lesson.lesson}${scope}${detail}`;
}

/**
 * Trim a list to what fits, newest first. Exported for its test: the cap is the
 * acceptance criterion "lessons cannot grow the prompt unboundedly", and a cap
 * only enforced inside an async database call is one nothing can check.
 */
export function capLessons(lessons: Lesson[], maxLessons = MAX_LESSONS, maxChars = MAX_CHARS): Lesson[] {
  const kept: Lesson[] = [];
  let used = HEADER.length + FOOTER.length;
  for (const lesson of lessons.slice(0, maxLessons)) {
    const cost = render(lesson).length + 1;
    if (used + cost > maxChars) break;
    kept.push(lesson);
    used += cost;
  }
  return kept;
}

/** The section, from a list already fetched. Empty string when there is nothing to say. */
export function lessonsSection(lessons: Lesson[]): string {
  const kept = capLessons(lessons);
  if (kept.length === 0) return "";
  return [HEADER, kept.map(render).join("\n"), FOOTER].join("\n");
}

/**
 * The section for a channel, straight from the database.
 *
 * Never throws: an unreachable lessons table means a turn with no lessons in
 * it, which is v1's behaviour and perfectly serviceable. Failing a crew
 * member's question because the reflection store is down would be a strange
 * price to pay for a self-improvement feature.
 */
export async function buildLessonsSection(channel: Channel): Promise<string> {
  try {
    return lessonsSection(await activeLessonsFor(channel, MAX_LESSONS));
  } catch (err) {
    console.warn(`[mort] could not load lessons for the ${channel} channel:`, err);
    return "";
  }
}
