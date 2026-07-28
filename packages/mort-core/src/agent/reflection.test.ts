import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Lesson } from "../memory/lessons";
import type { ReflectionSignals } from "../memory/signals";
import type { ToolContext } from "../tools/harness";

/**
 * The reflection loop's own rules (v2/P7).
 *
 * Three things are under test here and they map onto the three ways this
 * feature could go wrong:
 *
 *  1. A lesson invented out of nothing — the invented-reference guard, same
 *     reasoning as the dream's and the decision path's.
 *  2. A lesson a human already threw out coming back as new — the dedupe key,
 *     which is why it spans every status rather than just the active ones.
 *  3. Lessons eating the prompt they're injected into — the cap.
 */

const store = vi.hoisted(() => ({
  /** dedupe key → row, standing in for the UNIQUE constraint. */
  rows: new Map<string, Lesson>(),
}));

vi.mock("../memory/lessons", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../memory/lessons");
  return {
    ...actual,
    // The real INSERT ... ON CONFLICT (dedupe_key) DO NOTHING, in a Map: a
    // second lesson on the same key never lands, whatever the first one's
    // status is now.
    recordLesson: async (input: Parameters<typeof actual.recordLesson>[0]) => {
      const key = actual.lessonKey(input.lesson);
      const existing = store.rows.get(key);
      if (existing) return { lesson: existing, created: false };
      const lesson: Lesson = {
        id: `lesson-${store.rows.size + 1}`,
        ts: "2026-07-27T00:00:00.000Z",
        lesson: input.lesson,
        detail: input.detail ?? null,
        scope: input.scope ?? [],
        evidence: input.evidence ?? [],
        origin: input.origin ?? "dream",
        status: "active",
        retiredBy: null,
        retiredAt: null,
      };
      store.rows.set(key, lesson);
      return { lesson, created: true };
    },
  };
});

const { capLessons, lessonsSection, MAX_LESSONS } = await import("./lessons-prompt");
const { knownSignalIds, lessonProblem, newReflectState } = await import("./reflection");
const { noteLessonTool } = await import("./reflect-tools");
const { lessonKey } = await import("../memory/lessons");

const SIGNALS: ReflectionSignals = {
  days: 7,
  journal: [
    {
      id: 41,
      ts: "2026-07-24T09:00:00.000Z",
      channel: "chat",
      actor: "jayden@qubered.com",
      action: "fact_saved",
      rationale: "led-wall-height = 6m",
      confidence: 1,
      sourceId: null,
      corrected: true,
    },
  ],
  reviews: [
    {
      id: 7,
      action: "DREAM:MISSING_PAGE",
      status: "rejected",
      rationale: "no page covers the SDI floor runs",
      decidedBy: "jayden@qubered.com",
      decidedAt: "2026-07-25T09:00:00.000Z",
    },
  ],
  feedback: [
    {
      id: "fb-1",
      rating: "down",
      comment: "answered from the KB when the log said otherwise",
      answer: "The LED wall is at 2.5m.",
      question: "how high is the wall right now",
      createdAt: "2026-07-26T09:00:00.000Z",
    },
  ],
};

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: "l1",
  ts: "2026-07-27T00:00:00.000Z",
  lesson: "Check the event log before answering what something is set to now.",
  detail: null,
  scope: [],
  evidence: [],
  origin: "dream",
  status: "active",
  retiredBy: null,
  retiredAt: null,
  ...over,
});

const call = async (tool: unknown, args: unknown) =>
  (await (tool as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {})) as Record<
    string,
    unknown
  >;

const reflectCtx = (): ToolContext => ({
  channel: "dream",
  user: null,
  conversationId: null,
  seen: new Set(),
  reflect: newReflectState({ signals: SIGNALS, existing: [] }),
});

const DRAFT = {
  lesson: "Check the event log before answering what something is set to now.",
  detail: null,
  scope: ["chat"],
  evidence: [{ kind: "feedback" as const, id: "fb-1", note: "thumbs down on a stale answer" }],
};

beforeEach(() => {
  store.rows.clear();
});

describe("evidence has to be real", () => {
  const known = knownSignalIds(SIGNALS);

  it("accepts a lesson citing rows it was actually shown", () => {
    expect(lessonProblem({ lesson: DRAFT.lesson, evidence: DRAFT.evidence }, known)).toBeNull();
    expect(
      lessonProblem({ lesson: DRAFT.lesson, evidence: [{ kind: "journal", id: "41" }] }, known),
    ).toBeNull();
  });

  it("refuses one citing a row that doesn't exist in the window", () => {
    // The failure this exists to stop: a lesson that reads as evidence-backed,
    // survives review because checking it is work, and quietly teaches whoever
    // eventually checks to distrust the rest.
    const problem = lessonProblem({ lesson: DRAFT.lesson, evidence: [{ kind: "journal", id: "918" }] }, known);
    expect(problem).toMatch(/no journal row '918'/i);
  });

  it("refuses one citing the right id under the wrong kind", () => {
    // '7' is a review id, not a journal id. Getting this wrong points a reader
    // at a real row that says something else entirely.
    expect(lessonProblem({ lesson: DRAFT.lesson, evidence: [{ kind: "journal", id: "7" }] }, known)).toMatch(
      /no journal row '7'/i,
    );
  });

  it("refuses a lesson that isn't one sentence", () => {
    expect(
      lessonProblem({ lesson: "Do this.\nAlso do that.", evidence: DRAFT.evidence }, known),
    ).toMatch(/one sentence/i);
  });
});

describe("note_lesson", () => {
  it("files a validated lesson and reports it as live", async () => {
    const ctx = reflectCtx();
    const result = await call(noteLessonTool(ctx), DRAFT);

    expect(result.status).toBe("learned");
    expect(ctx.reflect!.learned.map((l) => l.lesson)).toEqual([DRAFT.lesson]);
  });

  it("tells Mort what he got wrong instead of dropping it silently", async () => {
    // The tool refuses rather than filtering afterwards, so the turn stays alive
    // to file a corrected one — a silent drop teaches nothing, which would be a
    // strange way to build the feature whose whole purpose is learning.
    const ctx = reflectCtx();
    const result = await call(noteLessonTool(ctx), {
      ...DRAFT,
      evidence: [{ kind: "review", id: "999" }],
    });

    expect(result.error).toMatch(/no review row '999'/i);
    expect(ctx.reflect!.learned).toHaveLength(0);
  });

  it("refuses to mean anything on a turn with no signals in front of it", async () => {
    const result = await call(noteLessonTool({ channel: "dream", user: null, conversationId: null, seen: new Set() }), DRAFT);
    expect(result.error).toMatch(/only means anything on a reflection turn/i);
  });

  it("files the same conclusion once, however it is worded", async () => {
    const ctx = reflectCtx();
    await call(noteLessonTool(ctx), DRAFT);
    const again = await call(noteLessonTool(ctx), { ...DRAFT, lesson: "check the event log before answering what something is set to now" });

    expect(again.status).toBe("already_known");
    expect(ctx.reflect!.learned).toHaveLength(1);
    expect(ctx.reflect!.duplicates).toBe(1);
  });

  it("never resurrects a lesson a human retired", async () => {
    // The acceptance criterion. The dedupe key spans every status, so a
    // reflection that reaches the same conclusion next week is told it was
    // already decided — the retired row is a decision a human made, and filing
    // a fresh copy would quietly overturn it.
    store.rows.set(lessonKey(DRAFT.lesson), lesson({ status: "retired", retiredBy: "jayden@qubered.com" }));

    const ctx = reflectCtx();
    const result = await call(noteLessonTool(ctx), DRAFT);

    expect(result.status).toBe("already_known");
    expect(result.note).toMatch(/retired/i);
    expect(ctx.reflect!.learned).toHaveLength(0);
  });
});

describe("lessons cannot grow the prompt unboundedly", () => {
  const many = (n: number, size = 60) =>
    Array.from({ length: n }, (_, i) => lesson({ id: `l${i}`, lesson: `Lesson ${i} `.padEnd(size, "x") }));

  it("keeps at most MAX_LESSONS, newest first", () => {
    expect(capLessons(many(40))).toHaveLength(MAX_LESSONS);
    expect(capLessons(many(40))[0].id).toBe("l0");
  });

  it("stops on the character budget even when the count is under the cap", () => {
    // Ten lessons is fine; ten essays is not. The budget is what actually holds
    // the line, because a lesson has no length limit a count can stand in for.
    const kept = capLessons(many(10, 900), MAX_LESSONS, 1_000);
    expect(kept.length).toBeLessThan(10);
    expect(lessonsSection(many(10, 900)).length).toBeLessThanOrEqual(3_200);
  });

  it("says nothing at all when there is nothing learnt", () => {
    expect(lessonsSection([])).toBe("");
  });

  it("renders each lesson with its scope and detail", () => {
    const section = lessonsSection([lesson({ scope: ["chat", "Lighting"], detail: "The log was newer." })]);
    expect(section).toContain("Check the event log");
    expect(section).toContain("(chat, Lighting)");
    expect(section).toContain("The log was newer.");
    // The frame that keeps a lesson in its place: below the rules, not above.
    expect(section).toMatch(/never let one override the rules below/i);
  });
});
