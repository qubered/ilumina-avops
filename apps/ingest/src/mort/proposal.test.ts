import { test } from "node:test";
import assert from "node:assert/strict";
import { dreamDedupeKey, knownRefs, proposalProblem, type DreamProposal } from "./proposal.js";
import type { DocEntry, LibraryEntry } from "./types.js";

function proposal(over: Partial<DreamProposal> = {}): DreamProposal {
  return {
    kind: "MISSING_PAGE",
    title: "No page covers the SDI floor runs",
    rationale: "Three files talk about it and nothing is written down.",
    sourceIds: ["Video/sdi.pdf"],
    docIds: [],
    confidence: 0.8,
    ...over,
  };
}

const lib = (sourceId: string): LibraryEntry => ({
  sourceId,
  role: "reference",
  summary: "s",
  zone: [],
  system: [],
  entities: [],
  hasDoc: false,
});

const doc = (mortId: string): DocEntry => ({
  mortId,
  outlineDocumentId: "o1",
  title: "T",
  system: null,
  collection: null,
  sourceCount: 1,
});

// --- dedupe key ------------------------------------------------------------

test("the same observation dreamt twice produces the same key", () => {
  // This is what stops a nightly dream from re-raising everything it has ever
  // noticed. Without it the queue fills with copies and gets ignored wholesale.
  const a = dreamDedupeKey({ kind: "MERGE", sourceIds: ["a"], docIds: ["d1"] });
  const b = dreamDedupeKey({ kind: "MERGE", sourceIds: ["a"], docIds: ["d1"] });
  assert.equal(a, b);
});

test("key ignores the order the model happened to list things in", () => {
  const a = dreamDedupeKey({ kind: "MERGE", sourceIds: [], docIds: ["d1", "d2"] });
  const b = dreamDedupeKey({ kind: "MERGE", sourceIds: [], docIds: ["d2", "d1"] });
  assert.equal(a, b);
});

test("different kinds about the same things are different proposals", () => {
  const merge = dreamDedupeKey({ kind: "MERGE", sourceIds: [], docIds: ["d1", "d2"] });
  const contra = dreamDedupeKey({ kind: "CONTRADICTION", sourceIds: [], docIds: ["d1", "d2"] });
  assert.notEqual(merge, contra);
});

test("different subjects are different proposals", () => {
  const a = dreamDedupeKey({ kind: "MERGE", sourceIds: [], docIds: ["d1"] });
  const b = dreamDedupeKey({ kind: "MERGE", sourceIds: [], docIds: ["d2"] });
  assert.notEqual(a, b);
});

// --- validation ------------------------------------------------------------

const KNOWN = knownRefs({ library: [lib("Video/sdi.pdf")], docs: [doc("d1")] });

test("a proposal about real files and pages is raisable", () => {
  assert.equal(proposalProblem(proposal(), KNOWN), null);
});

test("a proposal citing a file Mort doesn't have is refused, and says which", () => {
  const problem = proposalProblem(proposal({ sourceIds: ["Video/ghost.pdf"] }), KNOWN);
  assert.match(problem ?? "", /Video\/ghost\.pdf/);
});

test("a proposal citing a page Mort doesn't have is refused", () => {
  const problem = proposalProblem(proposal({ kind: "MERGE", sourceIds: [], docIds: ["nope"] }), KNOWN);
  assert.match(problem ?? "", /nope/);
});

test("a proposal about nothing at all is refused", () => {
  // No refs means there's nothing for a human to look at — it's a vibe, not an
  // observation.
  assert.notEqual(proposalProblem(proposal({ sourceIds: [], docIds: [] }), KNOWN), null);
});
