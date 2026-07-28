import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";

/**
 * The parity suite for the agent belt (v2/P6).
 *
 * Every case here is the same case as one in the v1 pipeline's `turn.test.ts`,
 * deliberately: the whole promise of P6 is that ingestion changed SHAPE and not
 * BEHAVIOUR. If a guard that held in the pipeline stops holding in the loop,
 * this file is where that shows up, and it should show up before a corpus does.
 *
 * The tools are driven directly rather than through a model. What is under test
 * is the gate, not the reasoning — and a gate that only holds when the model
 * behaves is not a gate.
 */

const state = vi.hoisted(() => ({ mode: "live" as string, threshold: 0.6 }));

vi.mock("../memory/config", () => ({
  getEffectiveMode: async () => state.mode,
  getEffectiveThreshold: async () => state.threshold,
}));
vi.mock("../memory/settings", () => ({ getSetting: async () => null }));
vi.mock("../memory", () => ({ listRelatedSources: async () => [] }));

const ingestTools = await import("./ingest-tools");
const { newIngestState } = ingestTools;
const { extractMortRegion } = await import("../kb/region");
import type { IngestDeps, IngestFile, IngestTurnState } from "./ingest-tools";
import type { ToolContext } from "../tools/harness";
import type { KbHit } from "./gather";

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

type Calls = {
  created: Array<{ title: string; regionBody: string }>;
  updated: Array<{ docId: string; regionBody: string }>;
  attached: Array<{ docId: string; sourceId: string }>;
  reviews: Array<{ action: string; targetDocId?: string | null; rationale?: string }>;
  searches: string[];
};

const hit = (docId: string, score = 0.9): KbHit => ({
  docId,
  title: `Page ${docId}`,
  url: "/u",
  breadcrumb: "b",
  score,
  text: "<!-- mort:start -->\nexisting region\n<!-- mort:end -->",
});

function harness(opts: { candidates?: KbHit[]; withAttach?: boolean; library?: Array<{ sourceId: string }> } = {}) {
  const calls: Calls = { created: [], updated: [], attached: [], reviews: [], searches: [] };
  const deps: IngestDeps = {
    kbSearch: async (q) => {
      calls.searches.push(q);
      return opts.candidates ?? [];
    },
    getDocumentText: async (docId) => (opts.candidates ?? []).find((c) => c.docId === docId)?.text ?? null,
    listRelatedFiles: async () =>
      (opts.library ?? []).map((f) => ({ sourceId: f.sourceId, role: "reference", summary: "s" })),
    createDoc: async (args) => {
      calls.created.push({ title: args.title, regionBody: args.regionBody });
      return "doc-new";
    },
    updateRegion: async (docId, regionBody) => {
      calls.updated.push({ docId, regionBody });
    },
    attachFile: opts.withAttach
      ? async (docId, sourceId) => {
          calls.attached.push({ docId, sourceId });
        }
      : undefined,
    enqueueReview: async (item) => {
      calls.reviews.push({ action: item.action, targetDocId: item.targetDocId, rationale: item.rationale });
      return true;
    },
    journal: async () => {},
  };
  const turn = newIngestState(FILE, deps);
  // The registry assembles this in production; here the tools are built
  // directly, because what is under test is the gate rather than the belt.
  const ctx = { channel: "ingest", user: null, conversationId: null, seen: new Set<string>(), ingest: turn } as ToolContext;
  const tools: ToolSet = {
    note_understanding: ingestTools.noteUnderstandingTool(ctx),
    create_page: ingestTools.createPageTool(ctx),
    update_page: ingestTools.updatePageTool(ctx),
    attach_to_page: ingestTools.attachToPageTool(ctx),
    hold_file: ingestTools.holdFileTool(ctx),
    skip_file: ingestTools.skipFileTool(ctx),
    send_to_review: ingestTools.sendToReviewTool(ctx),
  };
  return { turn, tools, calls, ctx };
}

/** Call a tool the way the model would. */
const call = (tools: ToolSet, name: string, args: unknown): Promise<Record<string, unknown>> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tools[name].execute as any)(args, { toolCallId: "t", messages: [] });

/** Every turn starts by saying what the file is; most tests need that done. */
const understand = (tools: ToolSet) => call(tools, "note_understanding", UNDERSTANDING);

const decide = (turn: IngestTurnState) => turn.decision!;

beforeEach(() => {
  state.mode = "live";
  state.threshold = 0.6;
});

describe("understanding comes first", () => {
  it("refuses every decision until Mort has said what the file is", async () => {
    const { tools, calls } = harness();
    for (const [name, args] of [
      ["create_page", { title: "T", collection: null, bodyMarkdown: "b", relatedSourceIds: [], rationale: "r", confidence: 0.9 }],
      ["update_page", { targetDocId: "d", bodyMarkdown: "b", relatedSourceIds: [], rationale: "r", confidence: 0.9 }],
      ["attach_to_page", { targetDocId: "d", rationale: "r", confidence: 0.9 }],
      ["hold_file", { rationale: "r" }],
      ["skip_file", { rationale: "r" }],
    ] as const) {
      expect(await call(tools, name, args)).toHaveProperty("error");
    }
    expect(calls.created).toHaveLength(0);
    expect(calls.reviews).toHaveLength(0);
  });

  it("searches several axes when it does, not just folder+filename", async () => {
    // The R7 retrieval, unchanged — it is the reason a decision is made with
    // the corpus in view rather than on a filename.
    const { tools, calls } = harness();
    await understand(tools);
    expect(calls.searches).toContain("Lighting E2");
    expect(calls.searches).toContain("Word procedure for LED wall rigging");
    expect(calls.searches).toContain("LED wall");
    expect(calls.searches).toContain("Lighting Main Stage");
  });

  it("only ever offers Mort's own section of a candidate page", async () => {
    const { tools } = harness({ candidates: [hit("doc-1")] });
    const res = (await understand(tools)) as { currentContent: Array<{ mortRegion: string }> };
    expect(res.currentContent[0].mortRegion).toBe("existing region");
  });

  it("won't let a second decision follow the first", async () => {
    const { tools, calls } = harness();
    await understand(tools);
    await call(tools, "hold_file", { rationale: "not sure" });
    const second = await call(tools, "create_page", {
      title: "T",
      collection: null,
      bodyMarkdown: "b",
      relatedSourceIds: [],
      rationale: "r",
      confidence: 0.99,
    });
    expect(second).toHaveProperty("error");
    expect(calls.created).toHaveLength(0);
  });
});

describe("the shadow / confidence gate", () => {
  it("sends even a confident CREATE to review in shadow mode, writing nothing", async () => {
    state.mode = "shadow";
    const { tools, turn, calls } = harness();
    await understand(tools);
    await call(tools, "create_page", {
      title: "T",
      collection: "Lighting",
      bodyMarkdown: "b",
      relatedSourceIds: [],
      rationale: "r",
      confidence: 0.99,
    });
    expect(decide(turn).executed).toBe("review");
    expect(calls.created).toHaveLength(0);
    expect(calls.reviews).toHaveLength(1);
  });

  it("sends a low-confidence CREATE to review in live mode", async () => {
    const { tools, turn, calls } = harness();
    await understand(tools);
    await call(tools, "create_page", {
      title: "T",
      collection: null,
      bodyMarkdown: "b",
      relatedSourceIds: [],
      rationale: "r",
      confidence: 0.3,
    });
    expect(decide(turn).executed).toBe("review");
    expect(calls.created).toHaveLength(0);
  });

  it("creates the page when live and confident", async () => {
    const { tools, turn, calls } = harness();
    await understand(tools);
    await call(tools, "create_page", {
      title: "LED wall rigging",
      collection: "Lighting",
      bodyMarkdown: "## Steps\n\nDo the thing.",
      relatedSourceIds: [],
      rationale: "nothing covers this",
      confidence: 0.9,
    });
    expect(decide(turn)).toMatchObject({ action: "CREATE", executed: "created", docId: "doc-new" });
    expect(calls.created).toHaveLength(1);
  });
});

describe("the invented-target guard", () => {
  it("reviews a confident update to a page Mort never saw, and strips the guessed id", async () => {
    const { tools, turn, calls } = harness({ candidates: [hit("real-doc-1")] });
    await understand(tools);
    await call(tools, "update_page", {
      targetDocId: "ghost",
      bodyMarkdown: "b",
      relatedSourceIds: [],
      rationale: "r",
      confidence: 0.99,
    });
    expect(decide(turn).executed).toBe("review");
    expect(calls.updated).toHaveLength(0);
    // A human must never be handed a made-up id to act on.
    expect(calls.reviews[0].targetDocId).toBeNull();
    expect(calls.reviews[0].rationale).toMatch(/guessed/i);
  });

  it("still executes an update to a page it really was shown", async () => {
    const { tools, turn, calls } = harness({ candidates: [hit("real-doc-1")] });
    await understand(tools);
    await call(tools, "update_page", {
      targetDocId: "real-doc-1",
      bodyMarkdown: "merged region",
      relatedSourceIds: [],
      rationale: "r",
      confidence: 0.9,
    });
    expect(decide(turn)).toMatchObject({ action: "UPDATE_ADDITIVE", executed: "updated", docId: "real-doc-1" });
    expect(calls.updated).toHaveLength(1);
  });

  it("reads the guard off the turn's seen set, so a follow-up kb_search counts", async () => {
    // Mort may look further than the retrieval he was handed — the shared
    // kb_search/kb_get_doc tools record into the same `ctx.seen` this reads.
    // What he must not do is target something he never looked at at all.
    const { tools, turn, ctx } = harness();
    await understand(tools);
    ctx.seen.add("late-doc");
    await call(tools, "update_page", {
      targetDocId: "late-doc",
      bodyMarkdown: "b",
      relatedSourceIds: [],
      rationale: "r",
      confidence: 0.9,
    });
    expect(decide(turn).executed).toBe("updated");
  });
});

describe("attach, hold and skip", () => {
  it("attaches when live, confident and the page is real", async () => {
    const { tools, turn, calls } = harness({ candidates: [hit("doc-9")], withAttach: true });
    await understand(tools);
    await call(tools, "attach_to_page", { targetDocId: "doc-9", rationale: "the show file for that page", confidence: 0.9 });
    expect(decide(turn)).toMatchObject({ action: "ATTACH", executed: "attached" });
    expect(calls.attached).toEqual([{ docId: "doc-9", sourceId: FILE.sourceId }]);
    expect(calls.reviews).toHaveLength(0);
  });

  it("proposes an attach in shadow mode even with an executor wired", async () => {
    state.mode = "shadow";
    const { tools, turn, calls } = harness({ candidates: [hit("doc-9")], withAttach: true });
    await understand(tools);
    await call(tools, "attach_to_page", { targetDocId: "doc-9", rationale: "r", confidence: 0.9 });
    expect(decide(turn).executed).toBe("review");
    expect(calls.attached).toHaveLength(0);
  });

  it("holds an attach aimed at an invented page — never attaches, never review noise", async () => {
    // There is nothing here a human could approve: the page doesn't exist. So
    // it isn't a proposal. Keep the file and move on; it gets re-checked when a
    // page it belongs on appears.
    const { tools, turn, calls } = harness({ candidates: [], withAttach: true });
    await understand(tools);
    await call(tools, "attach_to_page", { targetDocId: "made-up-id", rationale: "r", confidence: 0.99 });
    expect(decide(turn)).toMatchObject({ action: "HOLD", executed: "held" });
    expect(calls.attached).toHaveLength(0);
    expect(calls.reviews).toHaveLength(0);
  });

  it("proposes an attach when no attach executor is wired", async () => {
    const { tools, turn, calls } = harness({ candidates: [hit("doc-7")] });
    await understand(tools);
    await call(tools, "attach_to_page", { targetDocId: "doc-7", rationale: "r", confidence: 0.9 });
    expect(decide(turn).executed).toBe("review");
    expect(calls.reviews[0].action).toBe("ATTACH");
  });

  it("holds without queueing anything, in either mode", async () => {
    for (const mode of ["live", "shadow"]) {
      state.mode = mode;
      const { tools, turn, calls } = harness();
      await understand(tools);
      await call(tools, "hold_file", { rationale: "no page for it yet" });
      expect(decide(turn)).toMatchObject({ action: "HOLD", executed: "held" });
      expect(calls.reviews).toHaveLength(0);
      expect(calls.created).toHaveLength(0);
    }
  });

  it("skips without doing anything at all", async () => {
    const { tools, turn, calls } = harness();
    await understand(tools);
    await call(tools, "skip_file", { rationale: "empty file" });
    expect(decide(turn)).toMatchObject({ action: "SKIP", executed: "skipped" });
    expect(calls.reviews).toHaveLength(0);
    expect(calls.created).toHaveLength(0);
  });
});

describe("what gets written into the page", () => {
  it("renders the metadata header from the facets Mort stated, not from the model's prose", async () => {
    const { tools, calls } = harness();
    await understand(tools);
    await call(tools, "create_page", {
      title: "LED wall rigging",
      collection: "Lighting",
      bodyMarkdown: "## Steps\n\nDo the thing.",
      relatedSourceIds: [],
      rationale: "r",
      confidence: 0.9,
    });
    const body = calls.created[0].regionBody;
    expect(body).toMatch(/Zone: Main Stage/);
    expect(body).toMatch(/System: Lighting/);
    expect(body).toMatch(/Entities: LED wall/);
    expect(body).toMatch(/Source-Files: E2\.docx/);
    expect(body).toMatch(/Folder-Origin: Lighting/);
    // truth → the top of the source-of-truth hierarchy (MORT_PLAN IV.A).
    expect(body).toMatch(/Source-Tier: word/);
    expect(body).toMatch(/Maintained-By: Mort/);
    expect(body.trimEnd()).toMatch(/Do the thing\.$/);
  });

  it("drops a Related link to a library file Mort was never offered", async () => {
    // Same reasoning as the invented-target guard: a link to a file that
    // doesn't exist reads as authoritative and is worse than no link.
    const { tools, calls } = harness({ library: [{ sourceId: "Lighting/real.pdf" }] });
    await understand(tools);
    await call(tools, "create_page", {
      title: "T",
      collection: null,
      bodyMarkdown: "b",
      relatedSourceIds: ["Lighting/real.pdf", "Lighting/ghost.pdf"],
      rationale: "r",
      confidence: 0.9,
    });
    expect(calls.created[0].regionBody).toMatch(/Related: Lighting\/real\.pdf/);
    expect(calls.created[0].regionBody).not.toMatch(/ghost/);
  });

  it("shows a candidate as Mort's section, never the human's half of the page", async () => {
    // What an edit may rewrite and what Mort is shown are the same thing on
    // purpose. Showing the human half would invite the model to "helpfully"
    // restate it inside the region, where it would then be Mort's to overwrite.
    const { tools } = harness({
      candidates: [{ ...hit("doc-1"), text: "A HUMAN WROTE THIS\n<!-- mort:start -->\nexisting region\n<!-- mort:end -->" }],
    });
    const res = (await understand(tools)) as { currentContent: Array<{ mortRegion: string }> };
    expect(res.currentContent[0].mortRegion).toBe("existing region");
    expect(res.currentContent[0].mortRegion).not.toContain("A HUMAN WROTE THIS");
    // And what a write produces is a region body, spliced by the safe writer —
    // there is no path from here to the rest of the page.
    expect(extractMortRegion("<!-- mort:start -->\nx\n<!-- mort:end -->")).toBe("x");
  });
});

describe("the review queue", () => {
  it("dedupes on action + source + target, exactly as the pipeline did", async () => {
    state.mode = "shadow";
    const { tools, calls } = harness({ candidates: [hit("doc-3")] });
    await understand(tools);
    await call(tools, "update_page", {
      targetDocId: "doc-3",
      bodyMarkdown: "b",
      relatedSourceIds: [],
      rationale: "r",
      confidence: 0.9,
    });
    expect(calls.reviews[0]).toMatchObject({ action: "UPDATE_ADDITIVE", targetDocId: "doc-3" });
  });

  it("takes an explicit hand-off to a human without needing a body", async () => {
    const { tools, turn, calls } = harness({ candidates: [hit("doc-a"), hit("doc-b")] });
    await understand(tools);
    await call(tools, "send_to_review", {
      rationale: "two plausible pages and picking wrong matters",
      targetDocId: "doc-a",
      title: null,
      collection: null,
      bodyMarkdown: null,
    });
    expect(decide(turn)).toMatchObject({ action: "REVIEW", executed: "review" });
    expect(calls.reviews[0].action).toBe("REVIEW");
  });
});
