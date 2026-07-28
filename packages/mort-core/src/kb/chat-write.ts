import { createHash } from "node:crypto";
import { env } from "../env";
import {
  addRelation,
  appendJournal,
  findMortIdByOutlineId,
  getDocState,
  insertEvent,
  insertFact,
  upsertSource,
} from "../memory";
import type { PendingAction } from "../memory/pending";
import type { EventRow } from "../memory/types";
import type { ActingUser } from "../tools/policy";
import { condenseDiff, diffLines, diffStat, type DiffLine } from "./diff";
import { embedBatch } from "./embeddings";
import { ensureEventsCollection, upsertEvents } from "./events-store";
import { documentUrl, getDocumentOrNull, getSelfUserId } from "./outline";
import { extractMortRegion, isMalformedRegion } from "./region";
import { buildWriteDeps } from "./write-deps";
import { writeMortRegion } from "./writer";

/**
 * Chat-originated KB writes (MORT_V2_PLAN §I.4, Part II) on top of the v1
 * safe-write machinery: mort regions, per-doc locks, revision CAS,
 * human-edit detection, malformed-region → review.
 *
 * Nothing here decides POLICY (see tools/policy.ts) and nothing here is called
 * by the model. These are the preview builder the tools use to render a card,
 * and the executor the confirm route runs once a named human says yes.
 */

/** A source id for anything Mort learned in conversation rather than from a file. */
export function chatSourceId(conversationId: string | null | undefined): string {
  return `chat:${conversationId ?? "adhoc"}`;
}

export type DocEditPreview = {
  targetDocId: string;
  title: string;
  url: string;
  /** Mort's region as it stands now — empty string when the page has none yet. */
  before: string;
  after: string;
  diff: DiffLine[];
  added: number;
  removed: number;
  changed: boolean;
  /** The page has no Mort region yet; applying appends one (v1 rule). */
  appendsNewRegion: boolean;
  /** A stray marker — we cannot tell where Mort's content ends, so never auto-write. */
  malformed: boolean;
  /** A human edited this page since Mort last wrote it. */
  humanEditedSince: boolean;
};

/**
 * Build the before/after of a proposed region edit WITHOUT touching Outline.
 * Everything the confirmation card shows comes from here, so what the user
 * approves is what the executor writes.
 */
export async function previewDocEdit(targetDocId: string, regionBody: string): Promise<DocEditPreview | null> {
  const doc = await getDocumentOrNull(targetDocId);
  if (!doc) return null;

  const malformed = isMalformedRegion(doc.text);
  const before = malformed ? "" : (extractMortRegion(doc.text) ?? "");
  const after = regionBody.trim();
  const raw = diffLines(before, after);
  const { added, removed, changed } = diffStat(raw);

  const [selfUserId, prevState] = await Promise.all([
    getSelfUserId().catch(() => null),
    getDocState(targetDocId),
  ]);
  const updatedById = doc.updatedBy?.id ?? null;
  const humanEditedSince =
    prevState?.lastMortRevisionId != null &&
    updatedById != null &&
    selfUserId != null &&
    updatedById !== selfUserId &&
    String(doc.revision ?? "") !== prevState.lastMortRevisionId;

  return {
    targetDocId,
    title: doc.title,
    url: documentUrl(doc),
    before,
    after,
    diff: condenseDiff(raw),
    added,
    removed,
    changed,
    appendsNewRegion: !malformed && extractMortRegion(doc.text) === null,
    malformed,
    humanEditedSince,
  };
}

export type ExecutedWrite = {
  tool: PendingAction["tool"];
  /** The Outline document the write landed on, when it landed on one. */
  docId?: string;
  /** A one-line report for the model to relay to the user. */
  summary: string;
};

export type ExecuteOptions = {
  /**
   * Re-index the written page so retrieval reflects the change immediately.
   * Supplied by the assistant (which owns `kb_documents` and Qdrant indexing);
   * core stays out of the app's own tables. Best-effort — a failed re-index is
   * logged, never a failed write, because the nightly sync reconciles anyway.
   */
  onWritten?: (docId: string) => Promise<void>;
};

/**
 * Perform a confirmed pending action. `actor` comes from the confirming
 * session — NEVER from the payload — so `approved_by` and the journal record
 * the human who said yes, not whatever the model wrote down.
 */
export async function executePendingAction(
  action: PendingAction,
  actor: ActingUser,
  opts: ExecuteOptions = {},
): Promise<ExecutedWrite> {
  // Payloads come back out of jsonb, so read them defensively rather than
  // trusting the shape a tool put in weeks ago.
  const p = action.payload;
  const str = (k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
  const opt = (k: string): string | null => {
    const v = p[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const list = (k: string): string[] => {
    const v = p[k];
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return String(v ?? "")
      .split(/[,;/]/)
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const sourceId = chatSourceId(action.conversationId);
  const selfUserId = await getSelfUserId().catch(() => null);
  const deps = buildWriteDeps(selfUserId);

  const reindex = async (docId: string) => {
    if (!opts.onWritten) return;
    try {
      await opts.onWritten(docId);
    } catch (err) {
      console.error(`[mort] re-index after chat write to ${docId} failed:`, err);
    }
  };

  switch (action.tool) {
    case "apply_doc_edit": {
      const docId = str("targetDocId");
      if (!docId) throw new Error("apply_doc_edit has no target document");
      const label = opt("title") ?? docId;
      const result = await writeMortRegion(docId, str("regionBody"), selfUserId);
      await recordChatProvenance(sourceId, docId, "updated");
      await appendJournal({
        sourceId,
        outlineDocumentId: docId,
        action: "chat:update",
        rationale: `${opt("rationale") ?? "edited from chat"} (confirmed by ${actor.label})`,
        model: env.INGEST_AI_PROVIDER,
      });
      await reindex(docId);
      return {
        tool: action.tool,
        docId,
        summary: result.changed
          ? `Updated "${label}" in Outline.`
          : `"${label}" already said exactly that — nothing to change.`,
      };
    }

    case "create_doc": {
      const title = opt("title") ?? "Untitled";
      await upsertSource({
        sourceId,
        role: "truth",
        summary: `Told to Mort in chat${action.conversationId ? ` (conversation ${action.conversationId})` : ""}`,
      });
      const docId = await deps.createDoc({
        title,
        collection: opt("collection"),
        regionBody: str("regionBody"),
        sourceId,
      });
      await appendJournal({
        sourceId,
        outlineDocumentId: docId,
        action: "chat:create",
        rationale: `${opt("rationale") ?? "created from chat"} (confirmed by ${actor.label})`,
        model: env.INGEST_AI_PROVIDER,
      });
      await reindex(docId);
      return { tool: action.tool, docId, summary: `Created "${title}" in Outline.` };
    }

    case "attach_source": {
      const docId = str("targetDocId");
      const fileSourceId = str("sourceId");
      if (!docId || !fileSourceId) throw new Error("attach_source needs a target document and a source file");
      if (!deps.attachFile) throw new Error("attach executor unavailable");
      await deps.attachFile(docId, fileSourceId);
      await appendJournal({
        sourceId: fileSourceId,
        outlineDocumentId: docId,
        action: "chat:attach",
        rationale: `attached from chat (confirmed by ${actor.label})`,
        model: env.INGEST_AI_PROVIDER,
      });
      await reindex(docId);
      return { tool: action.tool, docId, summary: `Attached ${fileSourceId} to "${opt("title") ?? docId}".` };
    }

    case "save_fact": {
      const factKey = str("factKey");
      const value = str("value");
      const id = await insertFact({
        factKey,
        value,
        scope: opt("scope"),
        effectiveFrom: opt("effectiveFrom"),
        sourceTier: "human",
        // The one thing the model may never supply.
        approvedBy: actor.label,
        note: opt("note"),
      });
      await appendJournal({
        sourceId,
        action: "chat:fact",
        rationale: `${factKey} = ${value} (confirmed by ${actor.label})`,
      });
      return { tool: action.tool, summary: `Saved: ${factKey} = ${value} (fact #${id}).` };
    }

    case "log_event": {
      const row: EventRow = {
        rowHash: eventHash(str("actionText"), opt("occurredOn")),
        event: opt("event"),
        occurredOn: opt("occurredOn"),
        zone: list("zone"),
        system: list("system"),
        entities: list("entities"),
        actionText: str("actionText"),
      };
      await upsertSource({ sourceId, role: "event_log", summary: "Events logged in chat" });
      await insertEvent(sourceId, row);
      await indexChatEvent(sourceId, row);
      await appendJournal({
        sourceId,
        action: "chat:event",
        rationale: `${row.actionText} (reported by ${actor.label})`,
      });
      return { tool: action.tool, summary: `Logged: ${row.actionText}${row.occurredOn ? ` (${row.occurredOn})` : ""}.` };
    }

    default:
      throw new Error(`no executor for pending action '${action.tool}'`);
  }
}

/**
 * Record that this conversation now feeds a page. Mirrors what the ingest turn
 * does for a file, so "which sources feed this page?" answers "a chat did" —
 * which is the whole point of provenance.
 */
async function recordChatProvenance(sourceId: string, docId: string, relation: "updated" | "authored"): Promise<void> {
  await upsertSource({ sourceId, role: "truth", summary: "Told to Mort in chat" });
  const mortId = await findMortIdByOutlineId(docId);
  if (mortId) await addRelation(sourceId, mortId, relation);
}

/**
 * Chat-taught events reuse the spreadsheet path's row hash so they flow through
 * the same reconcile/index machinery: hash of the normalised content, unique
 * per (source, row).
 */
function eventHash(actionText: string, occurredOn: string | null): string {
  const normalised = `${occurredOn ?? ""}|${actionText.trim().toLowerCase().replace(/\s+/g, " ")}`;
  return createHash("sha256").update(normalised).digest("hex");
}

/**
 * Push one chat-logged event into the events vector store so `event_log` can
 * find it. Best-effort, exactly like the ingest path's indexEvents(): Postgres
 * is the source of truth and a reindex reconciles, so a Qdrant hiccup must not
 * fail a write the user already confirmed.
 *
 * Note this does NOT prune — unlike a spreadsheet, a conversation isn't a set
 * that gets re-sent, so there is nothing to reconcile away.
 */
async function indexChatEvent(sourceId: string, row: EventRow): Promise<void> {
  try {
    await ensureEventsCollection();
    const [vector] = await embedBatch([row.actionText], "document");
    await upsertEvents([
      {
        vector,
        payload: {
          sourceId,
          rowHash: row.rowHash,
          actionText: row.actionText,
          occurredOn: row.occurredOn,
          event: row.event,
          zone: row.zone,
          system: row.system,
          entities: row.entities,
        },
      },
    ]);
  } catch (err) {
    console.error(`[mort] event index push failed for ${sourceId}:`, err);
  }
}
