import { embedQuery } from "@mort/core/kb/embeddings";
import { searchKb } from "@mort/core/kb/store";

/**
 * KB search for the ingest authoring pipeline. Used to call the assistant's
 * /api/internal/kb-search over the compose network (single-Qdrant-owner
 * boundary); now a direct call into the shared kb/store — both services run
 * from the same mort-core, so there's no ownership question to route around.
 *
 * Graceful degradation preserved: any failure returns [] and logs — Mort then
 * decides with no KB context rather than the whole ingest turn dying.
 */

// The hit shape moved into core with gather() (v2/P3); re-exported here so the
// pipeline's existing imports are unchanged.
export type { KbHit } from "@mort/core/agent/gather";
import type { KbHit } from "@mort/core/agent/gather";

export async function kbSearch(query: string, limit = 5): Promise<KbHit[]> {
  try {
    const vector = await embedQuery(query);
    const hits = await searchKb(vector, limit);
    return hits.map((h) => ({
      docId: h.docId,
      title: h.title,
      url: h.url,
      breadcrumb: h.breadcrumb,
      score: h.score,
      text: h.text,
      zone: h.zone,
      system: h.system,
      docType: h.docType,
    }));
  } catch (err) {
    console.error("[kb-search] failed:", err);
    return [];
  }
}
