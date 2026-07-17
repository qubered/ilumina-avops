import { createHash } from "node:crypto";
import { getDocument, updateDocument } from "../outline.js";
import { withDocLock } from "./lock.js";
import { getDocState, recordDocState } from "./memory.js";
import { isMalformedRegion, spliceMortRegion } from "./region.js";

/**
 * The non-destructive writer (MORT v1.4). Updates ONLY Mort's fenced region in
 * an Outline doc; all human content is preserved byte-for-byte (see region.ts,
 * verified against live Outline 2026-07-16).
 *
 * Serialized per-doc so concurrent workers can't interleave a read-modify-write.
 * Reads fresh inside the lock, so a human edit landing between decision and write
 * is spliced into cleanly rather than clobbered.
 */

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export type WriteResult = {
  docId: string;
  revision: number | null;
  changed: boolean;
  /** A human edited this doc since Mort last wrote it — caller may want review for structural changes. */
  humanEditedSince: boolean;
};

/**
 * Set Mort's region in `docId` to `mortBody`. `selfUserId` is Mort's Outline
 * user id (from getSelfUserId) — used to detect human edits since Mort's last
 * write. Returns changed=false when the region already matches (no-op write).
 */
export async function writeMortRegion(
  docId: string,
  mortBody: string,
  selfUserId: string | null,
): Promise<WriteResult> {
  return withDocLock(docId, async () => {
    const doc = await getDocument(docId); // fresh read under the lock
    if (isMalformedRegion(doc.text)) {
      throw new Error(`doc ${docId} has a malformed Mort region — route to review, not auto-write`);
    }

    const prevState = await getDocState(docId);
    const humanEditedSince =
      prevState?.lastMortRevisionId != null &&
      doc.updatedById != null &&
      selfUserId != null &&
      doc.updatedById !== selfUserId &&
      String(doc.revision ?? "") !== prevState.lastMortRevisionId;

    const newText = spliceMortRegion(doc.text, mortBody);
    if (newText === doc.text) {
      return { docId, revision: doc.revision, changed: false, humanEditedSince };
    }

    const updated = await updateDocument({ id: docId, title: doc.title, text: newText, publish: true });
    await recordDocState({
      outlineDocumentId: docId,
      lastMortRevisionId: String(updated.revision ?? ""),
      lastMortBodyHash: sha256(mortBody.trim()),
    });
    return { docId, revision: updated.revision ?? null, changed: true, humanEditedSince };
  });
}
