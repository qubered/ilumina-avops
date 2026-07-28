import { describe, expect, it } from "vitest";
import { executeReview } from "./execute";
import type { ReviewRow } from "../memory";
import type { WriteDeps } from "./write-deps";

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
  } as unknown as WriteDeps;
  return { deps, calls };
}

describe("executeReview", () => {
  it("approve CREATE → creates the doc from the proposal payload", async () => {
    const { deps, calls } = fakeDeps();
    const r = await executeReview(row({ action: "CREATE" }), deps);
    expect(r.executed).toBe("created");
    expect(r.docId).toBe("doc-new");
    expect(calls.created.length).toBe(1);
  });

  it("approve UPDATE_ADDITIVE with target → updates that doc's region", async () => {
    const { deps, calls } = fakeDeps();
    const r = await executeReview(row({ action: "UPDATE_ADDITIVE", target_doc_id: "doc-42" }), deps);
    expect(r.executed).toBe("updated");
    expect(calls.updated).toEqual([{ docId: "doc-42" }]);
  });

  it("UPDATE_ADDITIVE with no target → throws (never a blind write)", async () => {
    const { deps } = fakeDeps();
    await expect(executeReview(row({ action: "UPDATE_ADDITIVE", target_doc_id: null }), deps)).rejects.toThrow(
      /no target/,
    );
  });

  it("approve ATTACH with target → attaches the stored file", async () => {
    const { deps, calls } = fakeDeps();
    const r = await executeReview(row({ action: "ATTACH", target_doc_id: "doc-7" }), deps);
    expect(r.executed).toBe("attached");
    expect(calls.attached).toEqual([{ docId: "doc-7", sourceId: "Lighting/E2.docx" }]);
  });

  it("ATTACH with no target → throws", async () => {
    const { deps } = fakeDeps();
    await expect(executeReview(row({ action: "ATTACH", target_doc_id: null }), deps)).rejects.toThrow(/no target/);
  });

  it("approve tombstone → removes the source (archives sole-authored docs)", async () => {
    const { deps, calls } = fakeDeps();
    const r = await executeReview(row({ action: "tombstone" }), deps);
    expect(r.executed).toBe("removed");
    expect(calls.removed).toEqual([{ sourceId: "Lighting/E2.docx" }]);
  });

  it("REVIEW-decided item has no executor → throws", async () => {
    const { deps } = fakeDeps();
    await expect(executeReview(row({ action: "REVIEW" }), deps)).rejects.toThrow(/no executor/);
  });
});
