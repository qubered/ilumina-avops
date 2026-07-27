import { buildWriteDeps } from "@mort/core/kb/write-deps";
import { getDocument } from "@mort/core/kb/outline";
import { listRelatedSources } from "@mort/core/memory";
import { decide } from "./decide.js";
import { understand } from "./understand.js";
import { kbSearch } from "./kbclient.js";
import type { TurnDeps } from "./turn.js";

/**
 * Assembles the real Mort turn dependencies: the write-only executors
 * (createDoc/updateRegion/attachFile/removeSource/enqueueReview/journal) come
 * from mort-core's buildWriteDeps — shared with the assistant's admin
 * review-approval route, which calls executeReview() the same way, no HTTP.
 * Only the LLM-pipeline fields (kbSearch/listRelatedFiles/getDocumentText/
 * understand/decide) are ingest-specific and assembled here.
 */
export function buildTurnDeps(selfUserId: string | null): TurnDeps {
  return {
    ...buildWriteDeps(selfUserId),
    kbSearch,
    // Mort's own library — the other files he holds that bear on this one. This
    // is what lets him reference/attach existing artifacts instead of judging
    // each file in isolation against the published KB alone.
    //
    // The system/entities filters are the R7 half of this: before, the lookup
    // only matched on folder, so a file was blind to anything filed elsewhere
    // however obviously related it was. It can pass them now because
    // understand() has already run.
    listRelatedFiles: listRelatedSources,
    // A stale search hit (indexed, since deleted) must not kill the turn — Mort
    // just decides without that candidate's body.
    getDocumentText: async (docId) => {
      try {
        return (await getDocument(docId)).text;
      } catch (err) {
        console.warn(`[mort] candidate ${docId} unreadable (stale index?): ${err instanceof Error ? err.message : err}`);
        return null;
      }
    },
    understand,
    decide,
  };
}
