import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision } from "./decide.js";
import type { KbHit } from "./kbclient.js";
import { runMortTurn, type TurnDeps, type TurnFile } from "./turn.js";

function makeDecision(over: Partial<Decision>): Decision {
  return {
    action: "CREATE",
    targetDocId: null,
    title: "New Doc",
    collection: "Lighting",
    confidence: 0.9,
    rationale: "because",
    zone: ["Main Stage"],
    system: ["Lighting"],
    docType: "How-to",
    entities: ["LED wall"],
    bodyMarkdown: "## Steps\n\nDo the thing.",
    ...over,
  };
}

type Calls = {
  created: number;
  updated: Array<{ docId: string }>;
  attached: Array<{ docId: string; sourceId: string }>;
  reviews: Array<{ action: string }>;
  journal: string[];
};

/** A KB candidate as kb_search would return it. */
function hit(docId: string): KbHit {
  return { docId, title: "Cand", url: "/u", breadcrumb: "b", score: 0.9, text: "t" };
}

function fakeDeps(decision: Decision, withAttach = false, candidates: KbHit[] = []): { deps: TurnDeps; calls: Calls } {
  const calls: Calls = { created: 0, updated: [], attached: [], reviews: [], journal: [] };
  const deps: TurnDeps = {
    kbSearch: async () => candidates,
    getDocumentText: async () => null,
    decide: async () => ({ decision, tokens: 1234 }),
    updateRegion: async (docId) => {
      calls.updated.push({ docId });
    },
    createDoc: async () => {
      calls.created++;
      return "doc-new";
    },
    attachFile: withAttach
      ? async (docId, sourceId) => {
          calls.attached.push({ docId, sourceId });
        }
      : undefined,
    enqueueReview: async (item) => {
      calls.reviews.push({ action: item.action });
      return true;
    },
    journal: async (e) => {
      calls.journal.push(e.action);
    },
  };
  return { deps, calls };
}

const FILE: TurnFile = {
  sourceId: "Lighting/E2.docx",
  fileName: "E2.docx",
  folderPath: "Lighting",
  extractedMarkdown: "patch notes",
};

test("shadow mode: even a confident CREATE goes to review, nothing is written", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "CREATE", confidence: 0.99 }));
  const out = await runMortTurn(FILE, { mode: "shadow", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "review");
  assert.equal(calls.created, 0);
  assert.equal(calls.reviews.length, 1);
});

test("live + low confidence → review", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "CREATE", confidence: 0.3 }));
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "review");
  assert.equal(calls.created, 0);
});

test("live + confident CREATE → creates the doc", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "CREATE", confidence: 0.9 }));
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "created");
  assert.equal(out.docId, "doc-new");
  assert.equal(calls.created, 1);
});

test("live + confident UPDATE_ADDITIVE with target → updates that doc's region", async () => {
  const { deps, calls } = fakeDeps(
    makeDecision({ action: "UPDATE_ADDITIVE", targetDocId: "doc-42", confidence: 0.9 }),
    false,
    [hit("doc-42")],
  );
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "updated");
  assert.deepEqual(calls.updated, [{ docId: "doc-42" }]);
});

test("UPDATE_ADDITIVE with no target → review, never a blind write", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "UPDATE_ADDITIVE", targetDocId: null, confidence: 0.9 }));
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "review");
  assert.equal(calls.updated.length, 0);
});

test("SKIP → nothing executed", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "SKIP", confidence: 0.9 }));
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "skipped");
  assert.equal(calls.created, 0);
  assert.equal(calls.reviews.length, 0);
});

test("ATTACH without an attach executor → proposed for review", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "ATTACH", targetDocId: "doc-7", confidence: 0.9 }));
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "review");
  assert.equal(calls.reviews[0].action, "ATTACH");
});

test("live + confident ATTACH with executor → attaches, no review", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "ATTACH", targetDocId: "doc-9", confidence: 0.9 }), true, [
    hit("doc-9"),
  ]);
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "attached");
  assert.deepEqual(calls.attached, [{ docId: "doc-9", sourceId: FILE.sourceId }]);
  assert.equal(calls.reviews.length, 0);
});

test("live + confident ATTACH to an INVENTED target → review, never executed", async () => {
  // kb_search returned nothing, but the model emitted a plausible doc id anyway.
  // Acting on it 403s against Outline — or lands on a real but wrong doc.
  const { deps, calls } = fakeDeps(
    makeDecision({ action: "ATTACH", targetDocId: "made-up-id", confidence: 0.99 }),
    true,
    [],
  );
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "review");
  assert.equal(calls.attached.length, 0, "must not attach to a guessed doc");
  assert.equal(calls.reviews.length, 1);
});

test("live + confident UPDATE to an INVENTED target → review, never written", async () => {
  const { deps, calls } = fakeDeps(
    makeDecision({ action: "UPDATE_ADDITIVE", targetDocId: "ghost", confidence: 0.99 }),
    false,
    [hit("real-doc-1")],
  );
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "review");
  assert.equal(calls.updated.length, 0);
});

test("live + confident UPDATE to a REAL candidate still executes", async () => {
  const { deps, calls } = fakeDeps(
    makeDecision({ action: "UPDATE_ADDITIVE", targetDocId: "real-doc-1", confidence: 0.9 }),
    false,
    [hit("real-doc-1")],
  );
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "updated");
  assert.deepEqual(calls.updated, [{ docId: "real-doc-1" }]);
});

test("shadow ATTACH always proposes even with an executor", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "ATTACH", targetDocId: "doc-9", confidence: 0.9 }), true);
  const out = await runMortTurn(FILE, { mode: "shadow", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "review");
  assert.equal(calls.attached.length, 0);
});
