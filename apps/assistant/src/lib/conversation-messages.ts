import { getPendingStatuses, type PendingStatus } from "@mort/core/memory/pending";
import type { MessageProvenance, PendingCardRef, Source } from "./db";

/** A confirmation card as the chat renders it: what was shown, plus where it got to. */
export type ChatCard = PendingCardRef & { status: PendingStatus };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: Source[] | null;
  pendingActions: ChatCard[] | null;
  /** Who taught the facts this answer leaned on, and when (v2 P2). */
  provenance: MessageProvenance[] | null;
};

type MessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: Source[] | null;
  pendingActions: PendingCardRef[] | null;
  provenance: MessageProvenance[] | null;
};

/**
 * Attach live status to the cards stored on each message. The message keeps
 * what was *shown*; `mort_pending_actions` keeps what *happened* — so a card
 * confirmed on a phone renders as confirmed on the desktop that raised it,
 * and one that quietly expired can't still be clicked.
 */
export async function withPendingStatus(rows: MessageRow[]): Promise<ChatMessage[]> {
  const ids = rows.flatMap((m) => (m.pendingActions ?? []).map((c) => c.id));
  const statuses = ids.length > 0 ? await getPendingStatuses(ids).catch(() => new Map()) : new Map();

  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    sources: m.sources,
    provenance: m.provenance,
    pendingActions:
      m.pendingActions?.map((card) => ({
        ...card,
        // A card whose row is gone (pruned database, reset) is treated as
        // expired rather than offered up for a write with no backing row.
        status: (statuses.get(card.id) as PendingStatus | undefined) ?? "expired",
      })) ?? null,
  }));
}
