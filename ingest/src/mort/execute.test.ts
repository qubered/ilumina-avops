import { test } from "node:test";
import assert from "node:assert/strict";
import { executeReview } from "./execute.js";
import type { ReviewRow } from "./memory.js";
import type { TurnDeps } from "./turn.js";

function row(over: Partial<ReviewRow>): ReviewRow {
  return {
    id: 1,
    action: "CREATE",
    source_id: "Lighting/E2.docx",
    mort_id: null,
    target_doc_id: null,
    payload: { title: "E2 Patching", collection: "Lighting", regionBody: "Zone: Main Stage\n\nbody" },
    rationale: "looks good",
    status: "pending",
    created_at: "now",
    ...over,
  };
}

function fakeDeps() {
  const calls = { created: [] as unknown[], updated: [] as Array<{ docId: string }> };
  const deps = {
    createDoc: async (a: { title: string }) => {
      calls.created.push(a);
      return "doc-new";
    },
    updateRegion: async (docId: string) => {
      calls.updated.push({ docId });
    },
  } as unknown as TurnDeps;
  return { deps, calls };
}

test("approve CREATE → creates the doc from the proposal payload", async () => {
  const { deps, calls } = fakeDeps();
  const r = await executeReview(row({ action: "CREATE" }), deps);
  assert.equal(r.executed, "created");
  assert.equal(r.docId, "doc-new");
  assert.equal(calls.created.length, 1);
});

test("approve UPDATE_ADDITIVE with target → updates that doc's region", async () => {
  const { deps, calls } = fakeDeps();
  const r = await executeReview(row({ action: "UPDATE_ADDITIVE", target_doc_id: "doc-42" }), deps);
  assert.equal(r.executed, "updated");
  assert.deepEqual(calls.updated, [{ docId: "doc-42" }]);
});

test("UPDATE_ADDITIVE with no target → throws (never a blind write)", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(() => executeReview(row({ action: "UPDATE_ADDITIVE", target_doc_id: null }), deps), /no target/);
});

test("ATTACH is not executable yet → throws clearly", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(() => executeReview(row({ action: "ATTACH" }), deps), /ATTACH needs the original file/);
});
