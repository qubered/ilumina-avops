import type { ReviewRow } from "./memory.js";
import type { TurnDeps } from "./turn.js";

/**
 * Executes an APPROVED review proposal (MORT_PLAN §P2). CREATE/UPDATE_ADDITIVE
 * carry their full content in the proposal payload, so they execute directly
 * and non-destructively (region splice). ATTACH and tombstone need the original
 * file bytes / a deletion flow that isn't wired yet — they're surfaced as errors
 * so the caller can leave them pending rather than silently no-op.
 */

export type ExecuteResult = { executed: "created" | "updated"; docId: string };

export async function executeReview(item: ReviewRow, deps: TurnDeps): Promise<ExecuteResult> {
  const payload = item.payload ?? {};
  switch (item.action) {
    case "CREATE": {
      const docId = await deps.createDoc({
        title: payload.title ?? item.source_id ?? "Untitled",
        collection: payload.collection ?? null,
        regionBody: payload.regionBody ?? "",
        sourceId: item.source_id ?? "",
      });
      return { executed: "created", docId };
    }
    case "UPDATE_ADDITIVE": {
      if (!item.target_doc_id) throw new Error("UPDATE_ADDITIVE proposal has no target doc");
      await deps.updateRegion(item.target_doc_id, payload.regionBody ?? "");
      return { executed: "updated", docId: item.target_doc_id };
    }
    default:
      throw new Error(
        `cannot execute action '${item.action}' yet — ATTACH needs the original file, ` +
          `tombstone/REVIEW need the deletion flow (P2 follow-ups)`,
      );
  }
}
