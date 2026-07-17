import { test } from "node:test";
import assert from "node:assert/strict";
import type { Decision } from "./decide.js";
import type { KbHit } from "./kbclient.js";
import type { Understanding } from "./understand.js";
import { runMortTurn, type TurnDeps, type TurnFile } from "./turn.js";

const UNDERSTANDING: Understanding = {
  summary: "Word procedure for LED wall rigging",
  zone: ["Main Stage"],
  system: ["Lighting"],
  entities: ["LED wall"],
  docType: "How-to",
};

function makeDecision(over: Partial<Decision>): Decision {
  return {
    action: "CREATE",
    targetDocId: null,
    title: "New Doc",
    collection: "Lighting",
    confidence: 0.9,
    rationale: "because",
    relatedSourceIds: [],
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
  /** Every query gather() fired, so tests can assert on retrieval breadth. */
  searches: string[];
};

/** A KB candidate as kb_search would return it. */
function hit(docId: string, score = 0.9): KbHit {
  return { docId, title: "Cand", url: "/u", breadcrumb: "b", score, text: "t" };
}

function fakeDeps(
  decision: Decision,
  withAttach = false,
  candidates: KbHit[] = [],
  over: Partial<TurnDeps> = {},
): { deps: TurnDeps; calls: Calls } {
  const calls: Calls = { created: 0, updated: [], attached: [], reviews: [], journal: [], searches: [] };
  const deps: TurnDeps = {
    kbSearch: async (q) => {
      calls.searches.push(q);
      return candidates;
    },
    getDocumentText: async () => null,
    understand: async () => ({ understanding: UNDERSTANDING, tokens: 100 }),
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
    ...over,
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

test("HOLD → filed in the library, no KB action, no review noise", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "HOLD", confidence: 0.9 }));
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "held");
  assert.equal(calls.created, 0);
  assert.equal(calls.updated.length, 0);
  assert.equal(calls.reviews.length, 0, "holding is not a proposal — nothing to approve");
});

test("HOLD in shadow mode is still just held (not queued)", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "HOLD", confidence: 0.9 }));
  const out = await runMortTurn(FILE, { mode: "shadow", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "held");
  assert.equal(calls.reviews.length, 0);
});

test("understanding is recorded on every path, even SKIP", async () => {
  const { deps } = fakeDeps(makeDecision({ action: "SKIP" }));
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.understanding.summary, "Word procedure for LED wall rigging");
  assert.deepEqual(out.understanding.entities, ["LED wall"]);
});

test("the library is offered to the decision", async () => {
  let seen: unknown;
  const { deps } = fakeDeps(makeDecision({ action: "HOLD" }));
  deps.listRelatedFiles = async () => [{ sourceId: "Lighting/MainStage_v3.show.gz", role: "reference", summary: "old show file" }];
  deps.decide = async (input) => {
    seen = input.gathered.library;
    return { decision: makeDecision({ action: "HOLD" }), tokens: 0 };
  };
  await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.deepEqual(seen, [{ sourceId: "Lighting/MainStage_v3.show.gz", role: "reference", summary: "old show file" }]);
});

test("the library is queried by what the file is ABOUT, not just its folder", async () => {
  // The R7 fix. Before, this lookup only got folderOrigin, so a related file
  // sitting in another folder was invisible however obviously connected.
  let seen: unknown;
  const { deps } = fakeDeps(makeDecision({ action: "HOLD" }));
  deps.listRelatedFiles = async (params) => {
    seen = params;
    return [];
  };
  await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.deepEqual(seen, {
    excludeSourceId: "Lighting/E2.docx",
    folderOrigin: "Lighting",
    system: ["Lighting"],
    entities: ["LED wall"],
  });
});

test("retrieval searches several axes, not just folder+filename", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "HOLD" }));
  await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.ok(calls.searches.includes("Lighting E2"), "placement query");
  assert.ok(calls.searches.includes("Word procedure for LED wall rigging"), "semantic query");
  assert.ok(calls.searches.includes("LED wall"), "entity query");
  assert.ok(calls.searches.includes("Lighting Main Stage"), "facet query");
});

test("understanding drives the decision, and its tokens are billed", async () => {
  let seen: unknown;
  let billed: number | undefined;
  const { deps } = fakeDeps(makeDecision({ action: "HOLD" }));
  deps.decide = async (input) => {
    seen = input.understanding;
    return { decision: makeDecision({ action: "HOLD" }), tokens: 1000 };
  };
  deps.journal = async (e) => {
    billed = e.tokens;
  };
  await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.deepEqual(seen, UNDERSTANDING);
  assert.equal(billed, 1100, "both passes count against the daily cap");
});

test("a decision that names a library file Mort never offered doesn't get linked", async () => {
  // Same reasoning as the invented-target guard: a Related link to a file that
  // doesn't exist reads as authoritative and is worse than no link at all.
  let body = "";
  const { deps } = fakeDeps(
    makeDecision({ action: "CREATE", relatedSourceIds: ["Lighting/real.pdf", "Lighting/ghost.pdf"] }),
  );
  deps.listRelatedFiles = async () => [{ sourceId: "Lighting/real.pdf", role: "reference", summary: "s" }];
  deps.createDoc = async (args) => {
    body = args.regionBody;
    return "doc-new";
  };
  await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.match(body, /Related: Lighting\/real\.pdf/);
  assert.doesNotMatch(body, /ghost/);
});

test("SKIP → nothing executed", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "SKIP", confidence: 0.9 }));
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "skipped");
  assert.equal(calls.created, 0);
  assert.equal(calls.reviews.length, 0);
});

test("ATTACH without an attach executor → proposed for review", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "ATTACH", targetDocId: "doc-7", confidence: 0.9 }), false, [
    hit("doc-7"),
  ]);
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

test("ATTACH to an INVENTED target → held, never attached and never review noise", async () => {
  // kb_search returned nothing, but the model emitted a plausible doc id anyway.
  // Acting on it 403s against Outline — or lands on a real but wrong doc. And
  // there's nothing a human could approve, so it's not a proposal: remember the
  // file and move on.
  const { deps, calls } = fakeDeps(
    makeDecision({ action: "ATTACH", targetDocId: "made-up-id", confidence: 0.99 }),
    true,
    [],
  );
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "held");
  assert.equal(calls.attached.length, 0, "must not attach to a guessed doc");
  assert.equal(calls.reviews.length, 0, "nothing to approve — don't queue it");
});

test("ATTACH with no target at all → held (the page doesn't exist yet)", async () => {
  const { deps, calls } = fakeDeps(makeDecision({ action: "ATTACH", targetDocId: null, confidence: 0.9 }), true);
  const out = await runMortTurn(FILE, { mode: "live", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "held");
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.attached.length, 0);
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
  const { deps, calls } = fakeDeps(makeDecision({ action: "ATTACH", targetDocId: "doc-9", confidence: 0.9 }), true, [
    hit("doc-9"),
  ]);
  const out = await runMortTurn(FILE, { mode: "shadow", confidenceThreshold: 0.6 }, deps);
  assert.equal(out.executed, "review");
  assert.equal(calls.attached.length, 0);
});
