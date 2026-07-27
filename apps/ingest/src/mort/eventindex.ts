import { embedBatch } from "@mort/core/kb/embeddings";
import { ensureEventsCollection, pruneEvents, upsertEvents, type EventPayload } from "@mort/core/kb/events-store";
import type { EventRow } from "./events.js";

/**
 * Embeds newly-ingested event rows and upserts them into the events Qdrant
 * collection, then prunes points whose row no longer exists in the sheet.
 * Used to push rows to the assistant's /api/internal/index-events over the
 * compose network; now a direct call into the shared kb/events-store.
 *
 * `mort_events` (Postgres) is still the source of truth — this is best-effort:
 * on failure the row still lives there and a reindex reconciles, so a turn
 * never fails because embedding/Qdrant is down.
 */
export async function indexEvents(sourceId: string, insertedRows: EventRow[], allRowHashes: string[]): Promise<void> {
  try {
    await ensureEventsCollection();

    if (insertedRows.length > 0) {
      const vectors = await embedBatch(
        insertedRows.map((r) => r.actionText),
        "document",
      );
      const points = insertedRows.map((r, i) => ({
        vector: vectors[i],
        payload: {
          sourceId,
          rowHash: r.rowHash,
          actionText: r.actionText,
          occurredOn: r.occurredOn,
          event: r.event,
          zone: r.zone,
          system: r.system,
          entities: r.entities,
        } as EventPayload,
      }));
      await upsertEvents(points);
    }

    // Reconcile: drop vectors for rows removed from the sheet.
    await pruneEvents(sourceId, allRowHashes);
  } catch (err) {
    console.error(`[mort] event index push failed for ${sourceId}:`, err);
  }
}
