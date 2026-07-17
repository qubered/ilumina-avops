import { generateObject } from "ai";
import { z } from "zod";
import type { Gathered } from "./gather.js";
import { MORT_AUTHORING_PREAMBLE } from "./identity.js";
import { getModel, modelLabel } from "./model.js";
import { withRateLimitRetry } from "../ratelimit.js";
import type { Understanding } from "./understand.js";
import type { FileRole } from "./types.js";

/**
 * Pass 3 of a Mort turn (MORT_PLAN §R7): given the file, what Mort understood it
 * to be, and everything related that gather() pulled up — decide how the KB
 * should change.
 *
 * This used to also produce the understanding (summary/zone/system/entities).
 * It no longer does: understand() owns that, which both breaks the retrieval
 * chicken-and-egg and shrinks this schema. Structured output is where cheap
 * models fail, and the failures scale with schema size — so the call that must
 * emit a whole article body is the one that can least afford extra fields.
 *
 * Still NOT a multi-step agent loop (that is R6).
 */

export const decisionSchema = z.object({
  action: z.enum(["CREATE", "UPDATE_ADDITIVE", "ATTACH", "HOLD", "REVIEW", "SKIP"]),
  targetDocId: z
    .string()
    .nullable()
    .describe(
      "For UPDATE_ADDITIVE/ATTACH: the targetDocId string copied EXACTLY from the candidate list " +
        "(a UUID like 0d9c1e3a-4b2f-...). Never a list position, a number, or a title. " +
        "null for CREATE/HOLD/SKIP.",
    ),
  title: z.string().nullable().describe("Title for a CREATE, else null"),
  collection: z.string().nullable().describe("Collection name for a CREATE, else null"),
  confidence: z.number().min(0).max(1).describe("0-1 confidence this is the right action AND target"),
  rationale: z.string().describe("One or two sentences, in Mort's voice, on why"),
  relatedSourceIds: z
    .array(z.string())
    .describe(
      "sourceIds from the library list you actually drew on or that the reader would want — copied " +
        "verbatim. These get linked on the page. Empty if none applied; do not list a file just " +
        "because it was offered.",
    ),
  bodyMarkdown: z
    .string()
    .describe(
      "The cleaned article body in markdown for CREATE/UPDATE_ADDITIVE. Do NOT include a metadata " +
        "header or an H1 title — Mort adds those. Empty for ATTACH/REVIEW/SKIP.",
    ),
});
export type Decision = z.infer<typeof decisionSchema>;

const INSTRUCTIONS = `You have already read this file and said what it is. Now decide what — if
anything — the knowledge base should do about it.

You are shown the pages that already exist and the other files Mort holds. Use them. They are
not decoration: the right move is usually to strengthen something that exists rather than add
another page beside it.

Judge whether this is ARTICLE material or REFERENCE material:

- ARTICLE material documents how something works or is done — Word procedures, specs, written
  knowledge someone would READ.
    → CREATE a new page (give title + collection), or UPDATE_ADDITIVE the right existing
      candidate (give targetDocId).
- REFERENCE material is an artifact you'd link or download, not read as prose — console/show
  files, config exports, schematics, photos, drawings. It NEVER becomes its own page.
    → ATTACH it to the page it belongs with (give targetDocId).
    → If no page for it exists yet, HOLD it. It stays in the library and gets attached when
      that page appears. Holding is cheap and reversible; a junk page is not.
- HOLD is also the right call when you simply aren't sure it deserves a page.
- REVIEW: you'd need to merge, restructure or overwrite, or two candidates are plausible
  and picking wrong matters — let a human decide.
- SKIP: genuinely nothing (empty, duplicate, irrelevant).

Rules:
- ONE FILE DOES NOT MEAN ONE PAGE. Most files are not article material. Prefer attaching or
  holding over creating a page that only restates an artifact.
- targetDocId MUST be copied verbatim from the candidate list below — the long UUID after
  "targetDocId:". Never a list position, a number, or a title. If no candidate fits, do not
  invent one: use CREATE or HOLD.
- Cite, don't copy. When a library file supports what you're writing, reference it in
  relatedSourceIds and describe what it is — never restate its contents as if you'd read them
  into the page.
- Set confidence honestly. A weak candidate match means low confidence (it goes to review).
- bodyMarkdown is the cleaned body ONLY — no metadata header, no H1 title (Mort renders those
  himself). Never invent facts.`;

/** A file already in Mort's library, offered as context for this decision. */
export type RelatedFile = { sourceId: string; role: string; summary: string | null };

export type DecideInput = {
  fileName: string;
  folderPath?: string;
  role: FileRole;
  extractedMarkdown: string;
  /** What pass 1 made of this file. */
  understanding: Understanding;
  /** What pass 2 pulled up: candidates, their bodies, and related library files. */
  gathered: Gathered;
};

const MAX_INPUT = 40_000;
/** Per-candidate body budget. Three bodies at 6k ≈ 18k chars of context — enough
 *  to judge near-duplicates without crowding out the file itself. */
const MAX_BODY = 6_000;

/** The decision plus what it cost — tokens feed the journal and the daily cap. */
export type DecideResult = { decision: Decision; tokens: number };

export async function decide(input: DecideInput): Promise<DecideResult> {
  const { understanding: u, gathered } = input;

  // Do NOT number this list. An earlier "[0] … [1] …" rendering invited the model
  // to answer with the list index ("1") instead of the doc id, which the
  // invented-target guard then had to reject — so a correct decision died on
  // formatting. Lead each line with the id it must copy.
  const candidateList = gathered.candidates
    .map((c) => `  - targetDocId: ${c.docId}\n      "${c.title}" (score ${c.score.toFixed(2)}) — ${c.breadcrumb}`)
    .join("\n");

  const relatedList = gathered.library
    .map((f) => `  [${f.role}] ${f.sourceId} — ${f.summary ?? "(not yet summarised)"}`)
    .join("\n");

  const bodies = gathered.bodies
    .map((b) => `--- "${b.title}" (${b.docId}) ---\n${b.text.slice(0, MAX_BODY)}`)
    .join("\n\n");

  const prompt = [
    `File: ${input.fileName}`,
    input.folderPath ? `Folder: ${input.folderPath}` : "",
    `Detected role: ${input.role}`,
    "",
    "What you already determined this file is:",
    `  Summary: ${u.summary}`,
    `  Zone: ${u.zone.join(", ") || "—"}`,
    `  System: ${u.system.join(", ") || "—"}`,
    `  Entities: ${u.entities.join(", ") || "—"}`,
    `  Type: ${u.docType ?? "—"}`,
    "",
    "Existing KB candidates (best first) — targetDocId must be one of these:",
    candidateList || "  (none — the KB has nothing similar)",
    "",
    "Other files already in Mort's library that bear on this one:",
    relatedList || "  (none)",
    "",
    bodies ? `Current content of the closest pages:\n${bodies}` : "",
    "",
    "Extracted file content:",
    input.extractedMarkdown.slice(0, MAX_INPUT),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    // Rate limits are handled here (honouring Retry-After) — free/shared tiers 429
    // constantly. maxRetries covers a transient malformed structured response.
    const { object, usage } = await withRateLimitRetry(() =>
      generateObject({
        model: getModel(),
        schema: decisionSchema,
        maxRetries: 2,
        system: `${MORT_AUTHORING_PREAMBLE}\n\n${INSTRUCTIONS}`,
        prompt,
      }),
    );
    return { decision: object, tokens: usage?.totalTokens ?? 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "No object generated" is cryptic and gets blamed on the file. It almost
    // never is: deciding needs a model that can hold a structured schema, and
    // small/free models simply can't.
    if (/no object generated|could not parse|did not return a response|invalid json|provider returned error/i.test(msg)) {
      throw new Error(
        `${msg} — ${modelLabel()} could not produce a valid decision. This is the model, not the file: ` +
          `Mort's decision is a structured-output task that small/free models fail at. Point ` +
          `INGEST_AI_PROVIDER/INGEST_MODEL at a capable model (e.g. anthropic + claude-sonnet-5). See ingest/README.md.`,
      );
    }
    throw err;
  }
}
