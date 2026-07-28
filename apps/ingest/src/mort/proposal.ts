import { createHash } from "node:crypto";
import { z } from "zod";
import type { DocEntry, LibraryEntry } from "./types.js";

/**
 * The shape, identity and validity of a dream proposal. Pure (no env / no model)
 * so it's testable — dream.ts holds the model call and re-exports this.
 */

export const DREAM_KINDS = ["MISSING_PAGE", "CONTRADICTION", "MERGE", "SPLIT"] as const;

export const dreamSchema = z.object({
  proposals: z
    .array(
      z.object({
        kind: z.enum(DREAM_KINDS),
        title: z.string().describe("Short headline for a human scanning a list, e.g. 'No page covers the SDI floor runs'"),
        rationale: z
          .string()
          .describe("Two or three sentences in Mort's voice: what you noticed, and why it's worth doing something about"),
        sourceIds: z.array(z.string()).describe("sourceIds from the library list this concerns — copied verbatim. Empty if none."),
        docIds: z.array(z.string()).describe("mortIds from the pages list this concerns — copied verbatim. Empty if none."),
        confidence: z.number().min(0).max(1).describe("0-1 how sure you are this is real and worth a human's time"),
      }),
    )
    .describe("Only what genuinely stands out. An empty list is a good answer when the KB is in decent shape."),
});

export type DreamProposal = z.infer<typeof dreamSchema>["proposals"][number];
export type DreamInput = { library: LibraryEntry[]; docs: DocEntry[] };

/**
 * Stable identity for a proposal: the kind plus what it's about. Sorted, so the
 * same observation from a later dream produces the same key and dedupes against
 * the earlier one instead of stacking up a fresh copy every night — which is
 * what stops a nightly dream from re-raising things a human already dismissed.
 */
export function dreamDedupeKey(p: Pick<DreamProposal, "kind" | "sourceIds" | "docIds">): string {
  const refs = [...p.sourceIds, ...p.docIds].sort().join("|");
  return `dream:${p.kind}:${createHash("sha256").update(refs).digest("hex").slice(0, 16)}`;
}

/**
 * Drop proposals that reference things Mort doesn't have. Same reasoning as the
 * invented-target guard on the decision path: a proposal pointing at a file or
 * page that doesn't exist wastes the reader's time working out that it's wrong,
 * and quietly teaches them to distrust the rest.
 */
export function validateProposals(proposals: DreamProposal[], input: DreamInput): DreamProposal[] {
  const sources = new Set(input.library.map((f) => f.sourceId));
  const docs = new Set(input.docs.map((d) => d.mortId));
  return proposals.filter((p) => {
    const okSources = p.sourceIds.every((id) => sources.has(id));
    const okDocs = p.docIds.every((id) => docs.has(id));
    if (!okSources || !okDocs) {
      console.warn(`[mort] dropping dream proposal "${p.title}" — it references something that doesn't exist`);
      return false;
    }
    // An observation about nothing is not an observation.
    return p.sourceIds.length + p.docIds.length > 0;
  });
}
