import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision } from "./decide.js";
import { runMortTurn, type TurnDeps, type TurnFile } from "./turn.js";

function makeDecision(over: Partial<Decision>): Decision {
  return {
    action: "CREATE",
    targetDocId: null,
    title: "New Doc",
    collection: "Lighting",
    confidence: 0.9,
    rationale: "because",
    regionBody: "Zone: Main Stage\n\nbody",
    ...over,
  };
}

type Calls = {
  created: number;
  updated: Array<{ docId: string }>;
  reviews: Array<{ action: string }>;
  journal: string[];
};

function fakeDeps(decision: Decision): { deps: TurnDeps; calls: Calls } {
  const calls: Calls = { created: 0, updated: [], reviews: [], journal: [] };
  const deps: TurnDeps = {
    kbSearch: async () => [],
    getDocumentText: async () => null,
    decide: async () => decision,
    updateRegion: async (docId) => {
      calls.updated.push({ docId });
    },
    createDoc: async () => {
      calls.created++;
      return "doc-new";
    },
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
  const { deps, calls } = fakeDeps(makeDecision({ action: "UPDATE_ADDITIVE", targetDocId: "doc-42", confidence: 0.9 }));
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

test("ATTACH is proposed for review (P1 — executor wiring is P2)", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "ATTACH", targetDocId: "doc-7", confidence: 0.9 }));
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "review");
  assert.equal(calls.reviews[0].action, "ATTACH");
});
