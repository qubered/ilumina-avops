import type { EventProvenance, MortFact, TaughtVia } from "./index";

/**
 * Provenance (v2 P2) — who told Mort something, when, and where it was said.
 *
 * Two consumers, one shape. The AGENT gets these fields in tool output so it
 * can answer "how do you know that?" verbatim from data instead of inventing a
 * plausible-sounding source. The UI gets the same objects on the message so it
 * can render a chip that links back to the moment the thing was learnt.
 *
 * Deliberately carries ids, not URLs: a link shape is the app's business, and
 * core has no idea what routes the assistant serves.
 */

export type ProvenanceVia = TaughtVia | "file";

export type ProvenanceChip = {
  kind: "fact" | "event";
  /** What the chip is about — a fact key, or the event's action text. */
  subject: string;
  /** The value asserted, for facts. */
  value: string | null;
  /** The person, or null when nobody claimed it (a sheet row, a file). */
  who: string | null;
  /** ISO date of when it was learnt/reported — null if unknown. */
  when: string | null;
  via: ProvenanceVia;
  /** Set for anything said in a conversation, so the UI can deep-link to it. */
  conversationId: string | null;
  messageId: string | null;
  /** Set for anything that came out of a file — the watcher's relative path. */
  sourceId: string | null;
};

/** "2026-07-23" → "23 Jul 2026". Fixed output; no locale surprises. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatProvenanceDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/**
 * When the fact was LEARNT, not when it took effect. "Jayden told me on 23
 * July" is a claim about the telling; `effective_from` is a claim about the
 * world, and the two are routinely different (you can tell Mort today about a
 * change that happened last week).
 */
export function factChip(fact: MortFact): ProvenanceChip {
  return {
    kind: "fact",
    subject: fact.factKey,
    value: fact.value,
    who: fact.approvedBy || null,
    when: fact.createdAt.slice(0, 10),
    via: fact.taughtVia,
    conversationId: fact.conversationId,
    messageId: fact.messageId,
    sourceId: null,
  };
}

export function eventChip(e: {
  actionText: string;
  occurredOn: string | null;
  sourceId: string | null;
  reportedBy?: string | null;
  conversationId?: string | null;
}): ProvenanceChip {
  return {
    kind: "event",
    subject: e.actionText,
    value: null,
    who: e.reportedBy ?? null,
    when: e.occurredOn,
    // An event with a reporter was told to Mort in conversation; one without
    // came off the actions spreadsheet, and the file is the attribution.
    via: e.reportedBy ? "chat" : "file",
    conversationId: e.conversationId ?? null,
    messageId: null,
    sourceId: e.sourceId,
  };
}

/**
 * The one-line sentence Mort can say back. This is what makes "how do you know
 * that?" answerable without the model composing an attribution out of vibes —
 * it is handed the finished sentence and told to use it as-is.
 */
export function describeProvenance(chip: ProvenanceChip): string {
  const when = formatProvenanceDate(chip.when);
  const where =
    chip.via === "chat"
      ? "in chat"
      : chip.via === "admin"
        ? "in the admin console"
        : chip.via === "file"
          ? chip.sourceId
            ? `from ${chip.sourceId}`
            : "from a file"
          : "from an ingested file";
  const who = chip.who ? `${chip.who} told me` : "recorded";
  return [who, when ? `on ${when}` : null, where].filter(Boolean).join(" — ");
}

/**
 * Convenience for the event path, whose provenance arrives split in two: the
 * search hit from the vector store, and the authoritative row from Postgres.
 * The row wins where they overlap — a vector point can be stale, the row that
 * indexed it cannot.
 */
export function eventChipFrom(
  hit: { actionText: string; occurredOn: string | null; sourceId: string },
  row: (EventProvenance & { occurredOn?: string | null }) | undefined,
): ProvenanceChip {
  return eventChip({ ...hit, ...row, occurredOn: row?.occurredOn ?? hit.occurredOn });
}
