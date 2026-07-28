import { createHash } from "node:crypto";
import type { EventRow } from "../memory/types";
import { embedBatch } from "./embeddings";
import { ensureEventsCollection, pruneEvents, upsertEvents, type EventPayload } from "./events-store";

/**
 * Getting an event row from Postgres into the vector store. One path, whether
 * the row came from an ingested spreadsheet or from someone telling Mort what
 * they just did — a chat-taught event is an ordinary event with a different
 * source id, so it flows through the same reconcile/index machinery.
 *
 * `mort_events` (Postgres) stays the source of truth: this is best-effort, and
 * on failure the row still lives there for a reindex to pick up. A turn never
 * fails because embeddings or Qdrant are down.
 */
export async function indexEvents(
  sourceId: string,
  insertedRows: EventRow[],
  allRowHashes: string[],
  /**
   * Who reported these rows and where (P2). Carried onto the point so a search
   * hit can be attributed without a second round trip; sheet rows have none,
   * and `mort_events` stays the authority for anything that needs certainty.
   */
  provenance: { reportedBy?: string | null; conversationId?: string | null } = {},
): Promise<void> {
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
          reportedBy: provenance.reportedBy ?? null,
          conversationId: provenance.conversationId ?? null,
        } as EventPayload,
      }));
      await upsertEvents(points);
    }

    // Reconcile: drop vectors for rows that no longer exist for this source.
    await pruneEvents(sourceId, allRowHashes);
  } catch (err) {
    console.error(`[mort] event index push failed for ${sourceId}:`, err);
  }
}

/**
 * Source id for events taught in conversation (MORT_V2_PLAN I.7). Namespacing
 * by conversation keeps chat-taught history separable from the spreadsheet's
 * without a second table, and makes "where did this come from" a string match.
 */
export function chatEventSourceId(conversationId: string): string {
  return `chat:${conversationId}`;
}

/**
 * Row hash for a chat-taught event: sha256 over the NORMALISED content, so the
 * same thing said twice in a conversation reconciles to one row rather than
 * two near-identical ones the crew has to read past.
 */
export function chatEventRowHash(row: { occurredOn?: string | null; actionText: string }): string {
  const normalised = [row.occurredOn ?? "", row.actionText.toLowerCase().replace(/\s+/g, " ").trim()].join("|");
  return createHash("sha256").update(normalised).digest("hex");
}
