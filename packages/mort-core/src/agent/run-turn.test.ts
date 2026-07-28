import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";

/**
 * The loop's own rails (v2/P6): bounded steps, one decision, an honest answer
 * when the model produces neither.
 *
 * The belt's behaviour is covered in ingest-tools.test.ts by driving the tools
 * directly. What's under test here is the thing only the loop can get wrong —
 * running away, deciding twice, or ending in a state the worker can't record.
 */

const rails = vi.hoisted(() => ({ maxSteps: 12 }));
const lessons = vi.hoisted(() => ({
  active: [] as Array<Record<string, unknown>>,
  filed: [] as string[],
}));

vi.mock("../memory/config", () => ({
  getEffectiveMode: async () => "live",
  getEffectiveThreshold: async () => 0.6,
  getMaxSteps: async () => rails.maxSteps,
  DEFAULT_MAX_STEPS: { chat: 10, ingest: 12, dream: 8 },
}));
vi.mock("../memory/settings", () => ({ getSetting: async () => null }));
vi.mock("../memory", () => ({ listRelatedSources: async () => [], enqueueReview: async () => true }));
vi.mock("../memory/tool-journal", () => ({ recordToolCall: async () => {} }));
vi.mock("../memory/spend", () => ({
  spendRail: () => ({ exceeded: async () => false, record: async () => {}, status: async () => ({}) }),
}));
// P5's belt reaches for connected servers; a turn under test has none.
vi.mock("../mcp", () => ({
  buildMcpAdminTools: () => ({}),
  buildMcpTools: async () => ({}),
  mcpTools: () => [],
  isMcpTool: () => false,
  MCP_RULES: "",
}));
// P7's lessons store, in memory: what the prompt reads and what a reflection
// writes.
vi.mock("../memory/lessons", () => ({
  activeLessonsFor: async () => lessons.active,
  listLessons: async () => lessons.active,
  recordLesson: async ({ lesson }: { lesson: string }) => {
    const created = !lessons.filed.includes(lesson);
    if (created) lessons.filed.push(lesson);
    return {
      created,
      lesson: { id: `l${lessons.filed.length}`, ts: "2026-07-27T00:00:00.000Z", lesson, scope: [], status: "active" },
    };
  },
}));

const { prepareTurn, runIngestTurn, runDreamTurn, runReflectionTurn } = await import("./run-turn");
import type { IngestDeps, IngestFile } from "./ingest-tools";

const FILE: IngestFile = {
  sourceId: "Lighting/E2.docx",
  fileName: "E2.docx",
  folderPath: "Lighting",
  extractedMarkdown: "patch notes",
  role: "truth",
};

const UNDERSTANDING = {
  summary: "Word procedure for LED wall rigging",
  zone: ["Main Stage"],
  system: ["Lighting"],
  entities: ["LED wall"],
  docType: "How-to",
};

function deps(): { deps: IngestDeps; created: string[] } {
  const created: string[] = [];
  return {
    created,
    deps: {
      kbSearch: async () => [],
      getDocumentText: async () => null,
      listRelatedFiles: async () => [],
      createDoc: async (a) => {
        created.push(a.title);
        return "doc-new";
      },
      updateRegion: async () => {},
      enqueueReview: async () => true,
      journal: async () => {},
    },
  };
}

type ScriptedCall = { tool: string; args: unknown };

/**
 * A model that makes the calls it's told to, one per step, then talks. Each
 * step costs 10 tokens so the turn's reported spend is checkable.
 */
function scripted(script: ScriptedCall[]) {
  let step = 0;
  const usage = {
    inputTokens: { total: 6, noCache: 6, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 4, text: 4, reasoning: 0 },
  };
  const finish = (unified: "stop" | "tool-calls") => ({ unified, raw: undefined });

  return new MockLanguageModelV4({
    doGenerate: async () => {
      const next = script[step++];
      if (!next) {
        return { content: [{ type: "text" as const, text: "done" }], finishReason: finish("stop"), usage, warnings: [] };
      }
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `call-${step}`,
            toolName: next.tool,
            input: JSON.stringify(next.args),
          },
        ],
        finishReason: finish("tool-calls"),
        usage,
        warnings: [],
      };
    },
  });
}

const CREATE = {
  tool: "create_page",
  args: {
    title: "LED wall rigging",
    collection: "Lighting",
    bodyMarkdown: "## Steps\n\nDo the thing.",
    relatedSourceIds: [],
    rationale: "nothing covers this",
    confidence: 0.9,
  },
};

describe("runTurn — ingest", () => {
  it("runs understand → decide and reports what it cost", async () => {
    const d = deps();
    const result = await runIngestTurn(FILE, d.deps, {
      model: scripted([{ tool: "note_understanding", args: UNDERSTANDING }, CREATE]),
    });

    expect(result.decision).toMatchObject({ action: "CREATE", executed: "created", docId: "doc-new" });
    expect(result.understanding?.summary).toBe(UNDERSTANDING.summary);
    expect(d.created).toEqual(["LED wall rigging"]);
    expect(result.steps).toBe(2);
    // The spend the worker bills against the daily cap: every step in the turn,
    // not just the last one. Under-reporting here would let a looping turn slip
    // past the cap.
    expect(result.tokens).toBe(20);
  });

  it("stops at the first decision instead of taking a second", async () => {
    const d = deps();
    const result = await runIngestTurn(FILE, d.deps, {
      model: scripted([{ tool: "note_understanding", args: UNDERSTANDING }, CREATE, CREATE]),
    });
    expect(result.decision.executed).toBe("created");
    expect(d.created).toHaveLength(1);
  });

  it("survives a refused decision and lets the model do the step it skipped", async () => {
    // Reaching for create_page before saying what the file is gets refused. The
    // turn must stay alive for the correction — stopping on the CALL rather
    // than on a recorded decision would turn every such slip into a silent
    // hold, and the file would never be filed.
    const d = deps();
    const result = await runIngestTurn(FILE, d.deps, {
      model: scripted([CREATE, { tool: "note_understanding", args: UNDERSTANDING }, CREATE]),
    });
    expect(result.decision.executed).toBe("created");
    expect(d.created).toEqual(["LED wall rigging"]);
  });

  it("holds — never guesses — when the step cap runs out with nothing decided", async () => {
    // The failure mode that matters: a turn that loops. Holding costs a delay
    // (the file is re-checked when a page appears); guessing costs a wrong page.
    rails.maxSteps = 3;
    const d = deps();
    const result = await runIngestTurn(FILE, d.deps, {
      model: scripted([
        { tool: "note_understanding", args: UNDERSTANDING },
        { tool: "kb_search", args: { query: "one" } },
        { tool: "kb_search", args: { query: "two" } },
        { tool: "kb_search", args: { query: "three" } },
        CREATE,
      ]),
    });
    expect(result.steps).toBe(3);
    expect(result.decision).toMatchObject({ action: "HOLD", executed: "held" });
    expect(result.decision.rationale).toMatch(/no decision within 3 step/);
    expect(d.created).toHaveLength(0);
    rails.maxSteps = 12;
  });

  it("still records an understanding-shaped outcome when the turn decides nothing at all", async () => {
    const d = deps();
    const result = await runIngestTurn(FILE, d.deps, {
      model: scripted([{ tool: "kb_search", args: { query: "x" } }]),
    });
    expect(result.decision.executed).toBe("held");
    expect(result.understanding).toBeNull();
  });
});

describe("runTurn — dream", () => {
  const digest = {
    library: [
      { sourceId: "Lighting/a.pdf", role: "reference", summary: "s", zone: [], system: [], entities: [], hasDoc: false },
    ],
    docs: [
      {
        mortId: "page-1",
        outlineDocumentId: "o1",
        title: "Main Stage — Lighting",
        collection: "Lighting",
        system: "Lighting",
        sourceCount: 1,
      },
    ],
  };

  it("raises what it validates and refuses what it invented", async () => {
    const result = await runDreamTurn(digest, {
      model: scripted([
        {
          tool: "raise_proposal",
          args: {
            kind: "MISSING_PAGE",
            title: "ghost",
            rationale: "r",
            sourceIds: ["Lighting/nope.pdf"],
            docIds: [],
            confidence: 0.9,
          },
        },
        {
          tool: "raise_proposal",
          args: {
            kind: "MISSING_PAGE",
            title: "real",
            rationale: "r",
            sourceIds: ["Lighting/a.pdf"],
            docIds: [],
            confidence: 0.9,
          },
        },
        { tool: "finish_dream", args: { summary: "had a look" } },
      ]),
    });
    expect(result.raised.map((p) => p.title)).toEqual(["real"]);
  });

  it("cannot reach a write tool at all — the channel has none", async () => {
    const result = await runDreamTurn(digest, {
      model: scripted([{ tool: "finish_dream", args: { summary: "nothing stood out" } }]),
    });
    expect(result.raised).toHaveLength(0);
  });
});

// --- the reflection (v2/P7) --------------------------------------------------

describe("runTurn — reflect", () => {
  const signals = {
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
        status: "rejected" as const,
        rationale: "no page covers the SDI floor runs",
        decidedBy: "jayden@qubered.com",
        decidedAt: "2026-07-25T09:00:00.000Z",
      },
    ],
    feedback: [],
  };

  const LEARN = {
    tool: "note_lesson",
    args: {
      lesson: "Read both pages before calling two of them a contradiction.",
      detail: null,
      scope: ["ingest"],
      evidence: [{ kind: "review", id: "7", note: "rejected — the pages agreed" }],
    },
  };

  beforeEach(() => {
    lessons.active = [];
    lessons.filed = [];
  });

  it("files what it can evidence and stops when it says it's done", async () => {
    const result = await runReflectionTurn(
      { signals, existing: [] },
      { model: scripted([LEARN, { tool: "finish_reflection", args: { summary: "one pattern" } }, LEARN]) },
    );

    expect(result.learned.map((l) => l.lesson)).toEqual([LEARN.args.lesson]);
    // Stopped ON finish_reflection: the third scripted call never ran.
    expect(result.steps).toBe(2);
  });

  it("refuses a lesson pointing at a row it was never shown", async () => {
    const result = await runReflectionTurn(
      { signals, existing: [] },
      {
        model: scripted([
          { ...LEARN, args: { ...LEARN.args, evidence: [{ kind: "journal", id: "918" }] } },
          { tool: "finish_reflection", args: { summary: "nothing solid" } },
        ]),
      },
    );
    expect(result.learned).toHaveLength(0);
  });

  it("learns nothing rather than something, and that is a normal night", async () => {
    const result = await runReflectionTurn(
      { signals, existing: [] },
      { model: scripted([{ tool: "finish_reflection", args: { summary: "a quiet week" } }]) },
    );
    expect(result.learned).toHaveLength(0);
    expect(result.blocked).toBeNull();
  });

  it("has no reach beyond a lesson — every writing tool is off the channel", async () => {
    // The reflection runs on the dream channel, so it inherits that channel's
    // whole trust model and adds exactly one capability.
    const plan = await prepareTurn(
      { kind: "reflect", input: { signals, existing: [] } },
      { channel: "dream", actor: "system" },
    );
    expect(Object.keys(plan.tools)).toContain("note_lesson");
    for (const tool of ["save_fact", "log_event", "create_page", "update_page", "raise_proposal", "propose_doc_edit"]) {
      expect(Object.keys(plan.tools)).not.toContain(tool);
    }
  });
});

describe("lessons in the prompt (P7)", () => {
  beforeEach(() => {
    lessons.active = [];
  });

  it("puts what Mort learnt ABOVE the rules he works under, never below", async () => {
    // The ordering is the mechanism, not the wording: the scope and safety
    // rules are framed as overriding and come last, so nothing distilled from
    // last week's journal can erode them.
    lessons.active = [
      {
        id: "l1",
        ts: "2026-07-27T00:00:00.000Z",
        lesson: "Check the event log before answering what something is set to now.",
        detail: null,
        scope: ["chat"],
        evidence: [],
        origin: "dream",
        status: "active",
        retiredBy: null,
        retiredAt: null,
      },
    ];
    const plan = await prepareTurn({ kind: "chat", messages: [] }, { channel: "chat", actor: "system" });

    const lessonAt = plan.system.indexOf("Check the event log before answering");
    const rulesAt = plan.system.indexOf("Scope — hard rules");
    expect(lessonAt).toBeGreaterThan(-1);
    expect(rulesAt).toBeGreaterThan(lessonAt);
  });

  it("leaves the prompt exactly as it was when nothing has been learnt", async () => {
    const plan = await prepareTurn({ kind: "chat", messages: [] }, { channel: "chat", actor: "system" });
    expect(plan.system).not.toMatch(/LESSONS/);
  });
});
