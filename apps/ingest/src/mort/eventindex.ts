import { env } from "../env.js";
import type { EventRow } from "./events.js";

/**
 * Pushes newly-ingested event rows to the assistant for embedding + Qdrant
 * upsert (the assistant is the single Qdrant owner). `mort_events` is the outbox
 * — this is best-effort: on failure the row still lives in Postgres and a
 * reindex reconciles, so a turn never fails because the assistant is down.
 */
export async function indexEvents(sourceId: string, insertedRows: EventRow[], allRowHashes: string[]): Promise<void> {
  if (!env.ASSISTANT_EVENTS_INDEX_URL) return;
  try {
    await fetch(env.ASSISTANT_EVENTS_INDEX_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId,
        allRowHashes,
        events: insertedRows.map((r) => ({
          rowHash: r.rowHash,
          actionText: r.actionText,
          occurredOn: r.occurredOn,
          event: r.event,
          zone: r.zone,
          system: r.system,
          entities: r.entities,
        })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(`[mort] event index push failed for ${sourceId}:`, err);
  }
}
