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

function fakeDeps(withAttach = true) {
  const calls = {
    created: [] as unknown[],
    updated: [] as Array<{ docId: string }>,
    attached: [] as Array<{ docId: string; sourceId: string }>,
    removed: [] as Array<{ sourceId: string }>,
  };
  const deps = {
    createDoc: async (a: { title: string }) => {
      calls.created.push(a);
      return "doc-new";
    },
    updateRegion: async (docId: string) => {
      calls.updated.push({ docId });
    },
    attachFile: withAttach
      ? async (docId: string, sourceId: string) => {
          calls.attached.push({ docId, sourceId });
        }
      : undefined,
    removeSource: async (sourceId: string) => {
      calls.removed.push({ sourceId });
      return { archivedDocIds: ["doc-arch"] };
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

test("approve ATTACH with target → attaches the stored file", async () => {
  const { deps, calls } = fakeDeps();
  const r = await executeReview(row({ action: "ATTACH", target_doc_id: "doc-7" }), deps);
  assert.equal(r.executed, "attached");
  assert.deepEqual(calls.attached, [{ docId: "doc-7", sourceId: "Lighting/E2.docx" }]);
});

test("ATTACH with no target → throws", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(() => executeReview(row({ action: "ATTACH", target_doc_id: null }), deps), /no target/);
});

test("approve tombstone → removes the source (archives sole-authored docs)", async () => {
  const { deps, calls } = fakeDeps();
  const r = await executeReview(row({ action: "tombstone" }), deps);
  assert.equal(r.executed, "removed");
  assert.deepEqual(calls.removed, [{ sourceId: "Lighting/E2.docx" }]);
});

test("REVIEW-decided item has no executor → throws", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(() => executeReview(row({ action: "REVIEW" }), deps), /no executor/);
});
