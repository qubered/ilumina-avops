import { createHash } from "node:crypto";
import { z } from "zod";
import type { DocEntry, LibraryEntry } from "../memory/types";

/**
 * The shape, identity and validity of a dream proposal. Pure (no env / no
 * model) so it's testable.
 *
 * Lives in core as of v2/P6, because the dream is a `runTurn` channel now
 * rather than a one-shot call in the ingest worker — and the validity rule in
 * particular has to sit next to the tool that enforces it.
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
 * Why a proposal can't be raised, or null if it can.
 *
 * Same reasoning as the invented-target guard on the decision path: a proposal
 * pointing at a file or page that doesn't exist wastes the reader's time
 * working out that it's wrong, and quietly teaches them to distrust the rest.
 *
 * It returns the reason rather than a boolean because the caller is a tool now
 * (v2/P6) — Mort gets told what he got wrong and can raise a corrected one,
 * where the old batch filter just dropped it silently after the fact.
 */
export function proposalProblem(
  p: Pick<DreamProposal, "sourceIds" | "docIds">,
  known: { sources: Set<string>; docs: Set<string> },
): string | null {
  const ghostSource = p.sourceIds.find((id) => !known.sources.has(id));
  if (ghostSource) return `'${ghostSource}' is not a file you hold. Copy ids from the list, don't reconstruct them.`;
  const ghostDoc = p.docIds.find((id) => !known.docs.has(id));
  if (ghostDoc) return `'${ghostDoc}' is not a page you maintain. Copy mortIds from the list verbatim.`;
  // An observation about nothing is not an observation.
  if (p.sourceIds.length + p.docIds.length === 0) {
    return "An observation about nothing is not an observation — name the files or pages it concerns.";
  }
  return null;
}

/** The id sets `proposalProblem` checks against, from a corpus digest. */
export function knownRefs(input: DreamInput): { sources: Set<string>; docs: Set<string> } {
  return {
    sources: new Set(input.library.map((f) => f.sourceId)),
    docs: new Set(input.docs.map((d) => d.mortId)),
  };
}
