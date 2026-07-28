import { describe, expect, it, vi } from "vitest";
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
vi.mock("../mcp", () => ({ buildMcpAdminTools: () => ({}), buildMcpTools: async () => ({}), mcpTools: () => [] }));

const { runIngestTurn, runDreamTurn } = await import("./run-turn");
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
