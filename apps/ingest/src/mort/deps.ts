import { buildWriteDeps } from "@mort/core/kb/write-deps";
import { getDocument } from "@mort/core/kb/outline";
import { listRelatedSources } from "@mort/core/memory";
import { recordToolCall, type ToolOutcome } from "@mort/core/memory/tool-journal";
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
 *
 * P4: the three retrieval deps are journaled to `mort_tool_calls` under their
 * registry names, on the `ingest` channel. They are the same three read-tier
 * tools the chat belt carries — the ingest turn just reaches them through a
 * hand-written pipeline rather than through the model choosing — so an audit
 * of "what did Mort look at, on which channel" covers both doors.
 *
 * The turn's KB WRITES are not journaled here, and shouldn't be: they aren't
 * tool calls. The pipeline decides, the decision passes the shadow/confidence
 * gates, and the executor writes — each of which already lands a decision entry
 * in `mort_journal` (create/update/attach/proposed:*) with its rationale and
 * confidence. P6 collapses this difference by putting ingestion on the agent
 * loop, at which point they become ordinary journaled tool calls like any other.
 */
export function buildTurnDeps(selfUserId: string | null): TurnDeps {
  return {
    ...buildWriteDeps(selfUserId),
    kbSearch: journaled("kb_search", kbSearch),
    // Mort's own library — the other files he holds that bear on this one. This
    // is what lets him reference/attach existing artifacts instead of judging
    // each file in isolation against the published KB alone.
    //
    // The system/entities filters are the R7 half of this: before, the lookup
    // only matched on folder, so a file was blind to anything filed elsewhere
    // however obviously related it was. It can pass them now because
    // understand() has already run.
    listRelatedFiles: journaled("mort_memory", listRelatedSources),
    // A stale search hit (indexed, since deleted) must not kill the turn — Mort
    // just decides without that candidate's body.
    getDocumentText: journaled("kb_get_doc", async (docId: string) => {
      try {
        return (await getDocument(docId)).text;
      } catch (err) {
        console.warn(`[mort] candidate ${docId} unreadable (stale index?): ${err instanceof Error ? err.message : err}`);
        return null;
      }
    }),
    understand,
    decide,
  };
}

/**
 * Wrap one retrieval dep so every call lands an audit row — the ingest-channel
 * equivalent of what tools/harness.ts does for the belt.
 *
 * No policy check here: these are read-tier tools and `read` is the only tier
 * the ingest channel has, so there is nothing this could refuse. The value is
 * the record, and the record must not be able to break the turn — a failed
 * insert is swallowed inside recordToolCall.
 */
function journaled<A extends unknown[], R>(
  tool: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const started = Date.now();
    let outcome: ToolOutcome = "ok";
    let detail: string | null = null;
    try {
      return await fn(...args);
    } catch (err) {
      outcome = "error";
      detail = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      void recordToolCall({
        tool,
        tier: "read",
        channel: "ingest",
        // Nobody asked: a file arrived and Mort acted on it. 'system' is the
        // honest actor, and the row a reader of an audit log wants to spot.
        actor: "system",
        args: args[0],
        outcome,
        detail,
        latencyMs: Date.now() - started,
      });
    }
  };
}
