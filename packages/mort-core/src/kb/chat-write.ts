import { addRelation, findMortIdByOutlineId, getDocState, upsertSource } from "../memory";
import { condenseDiff, diffLines, diffStat, type DiffLine } from "./diff";
import { documentUrl, getDocumentOrNull, getSelfUserId } from "./outline";
import { extractMortRegion, isMalformedRegion } from "./region";

/**
 * The read half of chat-originated KB writes (MORT_V2_PLAN Part II): work out
 * what an edit WOULD do, without touching Outline.
 *
 * Everything the confirmation card shows comes from here, so what the user
 * approves is what the executor writes. The executor itself lives with the
 * other confirm-then-live executors in agent/pending-actions.ts.
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
 * Build the before/after of a proposed region edit. Reads Outline; writes
 * nothing.
 *
 * `humanEditedSince` is the same comparison writeMortRegion makes under its
 * lock — computed here too so the card can warn BEFORE the user commits,
 * rather than only being noticed after the write.
 */
export async function previewDocEdit(targetDocId: string, regionBody: string): Promise<DocEditPreview | null> {
  const doc = await getDocumentOrNull(targetDocId);
  if (!doc) return null;

  const malformed = isMalformedRegion(doc.text);
  const region = malformed ? null : extractMortRegion(doc.text);
  const before = region ?? "";
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
    appendsNewRegion: !malformed && region === null,
    malformed,
    humanEditedSince,
  };
}

/**
 * Record that this conversation now feeds a page. Mirrors what the ingest turn
 * does for a file, so "which sources feed this page?" answers "a chat did" —
 * which is the whole point of provenance.
 */
export async function recordChatProvenance(
  sourceId: string,
  docId: string,
  relation: "updated" | "authored",
): Promise<void> {
  await upsertSource({ sourceId, role: "truth", summary: "Told to Mort in chat" });
  const mortId = await findMortIdByOutlineId(docId);
  if (mortId) await addRelation(sourceId, mortId, relation);
}
