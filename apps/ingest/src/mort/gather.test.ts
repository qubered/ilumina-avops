import { test } from "node:test";
import assert from "node:assert/strict";
import { gather, mergeHits, searchQueries, type GatherDeps } from "./gather.js";
import type { KbHit } from "./kbclient.js";
import type { Understanding } from "./understand.js";

const U: Understanding = {
  summary: "Word procedure for LED wall rigging",
  zone: ["Main Stage"],
  system: ["Lighting"],
  entities: ["LED wall", "grandMA3"],
  docType: "How-to",
};

const FILE = { sourceId: "Lighting/E2.docx", fileName: "E2.docx", folderPath: "Lighting" };

const hit = (docId: string, score: number): KbHit => ({
  docId,
  title: docId,
  url: "/u",
  breadcrumb: "b",
  score,
  text: "t",
});

// --- searchQueries ---------------------------------------------------------

test("searches placement, semantics, entities and facets", () => {
  assert.deepEqual(searchQueries(FILE, U), [
    "Lighting E2",
    "Word procedure for LED wall rigging",
    "LED wall grandMA3",
    "Lighting Main Stage",
  ]);
});

test("a file with no facets doesn't fire blank searches", () => {
  // A blank query returns arbitrary top hits, which is worse than not searching:
  // it puts unrelated docs in front of the model as if they were candidates.
  const bare: Understanding = { summary: "", zone: [], system: [], entities: [], docType: null };
  assert.deepEqual(searchQueries(FILE, bare), ["Lighting E2"]);
});

test("identical axes collapse to one search", () => {
  const u: Understanding = { ...U, summary: "LED wall", entities: ["LED wall"], zone: [], system: [] };
  const qs = searchQueries(FILE, u);
  assert.deepEqual(qs, ["Lighting E2", "LED wall"]);
});

test("a file with no folder still searches on its name", () => {
  const qs = searchQueries({ sourceId: "E2.docx", fileName: "E2.docx" }, U);
  assert.equal(qs[0], "E2");
});

// --- mergeHits -------------------------------------------------------------

test("merging dedupes by doc and keeps the best score", () => {
  const merged = mergeHits([[hit("a", 0.5)], [hit("a", 0.9)]]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].score, 0.9);
});

test("a doc found by several axes outranks a lone hit of the same score", () => {
  // Agreement across axes is evidence: the doc that both the filename and the
  // entities point at is likelier to be the one.
  const merged = mergeHits([[hit("agreed", 0.8)], [hit("agreed", 0.8)], [hit("lone", 0.8)]]);
  assert.equal(merged[0].docId, "agreed");
});

test("agreement is a nudge, not a trump card", () => {
  // Four weak matches must not bury one strong one — a runaway consensus bonus
  // would let vocabulary overlap outrank an actual match.
  const merged = mergeHits([[hit("weak", 0.3)], [hit("weak", 0.3)], [hit("weak", 0.3)], [hit("strong", 0.9)]]);
  assert.equal(merged[0].docId, "strong");
});

test("merging caps the candidate list", () => {
  const many = Array.from({ length: 20 }, (_, i) => [hit(`d${i}`, i / 20)]);
  assert.equal(mergeHits(many).length, 6);
});

test("merging nothing is not an error", () => {
  assert.deepEqual(mergeHits([[], []]), []);
});

// --- gather ----------------------------------------------------------------

function fakeDeps(over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    kbSearch: async () => [],
    getDocumentText: async () => "body",
    ...over,
  };
}

test("gather reads several candidate bodies, not just the top one", async () => {
  const read: string[] = [];
  const g = await gather(FILE, U, {
    ...fakeDeps(),
    kbSearch: async () => [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7), hit("d", 0.6)],
    getDocumentText: async (id) => {
      read.push(id);
      return `body of ${id}`;
    },
  });
  assert.deepEqual(read, ["a", "b", "c"], "top 3 read in full");
  assert.equal(g.bodies.length, 3);
  assert.equal(g.candidates.length, 4, "all candidates still offered as targets");
});

test("an unreadable candidate is dropped from bodies but stays targetable", async () => {
  // A stale search hit (indexed, since deleted) must not remove a live doc from
  // the candidate list — it just means Mort decides without that body.
  const g = await gather(FILE, U, {
    ...fakeDeps(),
    kbSearch: async () => [hit("gone", 0.9), hit("live", 0.8)],
    getDocumentText: async (id) => (id === "gone" ? null : "body"),
  });
  assert.deepEqual(g.bodies.map((b) => b.docId), ["live"]);
  assert.equal(g.candidates.length, 2);
});

test("one failing search doesn't lose the others", async () => {
  const g = await gather(FILE, U, {
    ...fakeDeps(),
    kbSearch: async (q) => {
      if (q === "Lighting E2") throw new Error("boom");
      return [hit("found", 0.9)];
    },
  });
  assert.deepEqual(g.candidates.map((c) => c.docId), ["found"]);
});

test("the library lookup is passed what the file is about", async () => {
  let seen: unknown;
  await gather(FILE, U, {
    ...fakeDeps(),
    listRelatedFiles: async (params) => {
      seen = params;
      return [];
    },
  });
  assert.deepEqual(seen, {
    excludeSourceId: "Lighting/E2.docx",
    folderOrigin: "Lighting",
    system: ["Lighting"],
    entities: ["LED wall", "grandMA3"],
  });
});

test("a failing library lookup degrades to no library, not a dead turn", async () => {
  const g = await gather(FILE, U, {
    ...fakeDeps(),
    listRelatedFiles: async () => {
      throw new Error("pg down");
    },
  });
  assert.deepEqual(g.library, []);
});
