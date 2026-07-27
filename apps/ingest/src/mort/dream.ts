import { generateObject } from "ai";
import { MORT_AUTHORING_PREAMBLE } from "./identity.js";
import { getModel, modelLabel } from "./model.js";
import { dreamSchema, type DreamInput, type DreamProposal } from "./proposal.js";
import { withRateLimitRetry } from "../ratelimit.js";
import type { DocEntry, LibraryEntry } from "./types.js";

export { DREAM_KINDS, dreamDedupeKey, dreamSchema, validateProposals } from "./proposal.js";
export type { DreamInput, DreamProposal } from "./proposal.js";

/**
 * The dream (MORT_PLAN §R7): Mort stepping back from the file in front of him
 * and looking at the whole corpus.
 *
 * Every other part of Mort is reactive — a file arrives, he decides about that
 * file. That structure has a blind spot no amount of per-file cleverness fixes:
 * a turn can only ever answer questions ABOUT ITS FILE. It cannot notice that
 * three artifacts imply a page nobody has written, that two pages contradict
 * each other, or that a page has quietly become two pages. Those are properties
 * of the corpus, and nothing was ever looking at the corpus.
 *
 * It also fixes a staleness that is structural rather than accidental: file #12
 * was decided when Mort knew 11 files. By file #300 the picture is completely
 * different, and nothing revisits #12. The dream is what revisits it.
 *
 * A dream NEVER writes. It only ever proposes, because every question it asks
 * is a judgement call about what the KB should be — which is the user's call,
 * not Mort's. Proposals are idempotent on a stable dedupe key (proposal.ts), so
 * dreaming nightly re-raises nothing already seen and dismissed.
 */

const INSTRUCTIONS = `This is not about any one file. You are looking at your whole corpus at once —
every file you hold and every page you maintain — and asking what you can only see from here.

Four things worth raising:

- MISSING_PAGE: several files clearly concern something no page covers. The strongest signal is
  a cluster of artifacts with no page between them — someone has been working on a thing nobody
  documented.
- CONTRADICTION: two pages disagree about how something is done or configured. Say which two,
  and about what.
- MERGE: two pages are really the same page, arrived at from different directions.
- SPLIT: one page has grown into two unrelated topics wearing one title.

Rules:
- Raise only what genuinely stands out. An empty list is a good answer and a much better one
  than a list of maybes — every proposal costs a human's attention, and a noisy dream gets
  ignored, which costs you the real ones too.
- Copy sourceIds and mortIds VERBATIM from the lists. Never invent one.
- You are only proposing. Nothing here gets written without a human agreeing, so say what you
  actually think rather than hedging — but confidence must be honest.
- A file having no page is NOT by itself a missing page. Most artifacts should never have one;
  show files, config exports and photos belong attached to a page, not made into one. Raise
  MISSING_PAGE for a subject with nothing written about it, never for an unfiled file.`;

export type DreamResult = { proposals: DreamProposal[]; tokens: number };

function renderLibrary(library: LibraryEntry[]): string {
  return library
    .map((f) => {
      const facets = [f.system.join("/"), f.zone.join("/"), f.entities.join(", ")].filter(Boolean).join(" · ");
      return `  [${f.role}]${f.hasDoc ? "" : " (unfiled)"} ${f.sourceId} — ${f.summary ?? "(not yet summarised)"}${
        facets ? ` · ${facets}` : ""
      }`;
    })
    .join("\n");
}

function renderDocs(docs: DocEntry[]): string {
  return docs
    .map((d) => `  - mortId: ${d.mortId}\n      "${d.title}" [${d.system ?? "—"}] in ${d.collection ?? "—"} · ${d.sourceCount} source(s)`)
    .join("\n");
}

export async function dream(input: DreamInput): Promise<DreamResult> {
  const prompt = [
    `Files you hold (${input.library.length}):`,
    renderLibrary(input.library) || "  (none)",
    "",
    `Pages you maintain (${input.docs.length}):`,
    renderDocs(input.docs) || "  (none)",
  ].join("\n");

  try {
    const { object, usage } = await withRateLimitRetry(() =>
      generateObject({
        model: getModel(),
        schema: dreamSchema,
        maxRetries: 2,
        system: `${MORT_AUTHORING_PREAMBLE}\n\n${INSTRUCTIONS}`,
        prompt,
      }),
    );
    return { proposals: object.proposals, tokens: usage?.totalTokens ?? 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no object generated|could not parse|did not return a response|invalid json|provider returned error/i.test(msg)) {
      throw new Error(
        `${msg} — ${modelLabel()} could not produce a valid dream. This is the model, not the corpus. ` +
          `See ingest/README.md.`,
      );
    }
    throw err;
  }
}
