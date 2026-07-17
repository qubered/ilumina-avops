import { generateObject } from "ai";
import { z } from "zod";
import { MORT_AUTHORING_PREAMBLE } from "./identity.js";
import type { KbHit } from "./kbclient.js";
import { getModel } from "./model.js";
import type { FileRole } from "./types.js";

/**
 * Mort's single structured decision (MORT_PLAN §v1.3). One LLM call per file:
 * given the file, its role, and KB candidates, decide how the KB should change.
 * NOT a multi-step agent loop (that is R6).
 */

export const decisionSchema = z.object({
  action: z.enum(["CREATE", "UPDATE_ADDITIVE", "ATTACH", "HOLD", "REVIEW", "SKIP"]),
  summary: z
    .string()
    .describe(
      "One line: what this file IS (e.g. 'grandMA3 show file for Main Stage, v4', " +
        "'Word procedure for E2 camera patching'). ALWAYS fill this in — it goes in Mort's " +
        "library so he can find and reference this file later, even if it never becomes an article.",
    ),
  targetDocId: z
    .string()
    .nullable()
    .describe("Outline doc id (from a candidate) for UPDATE_ADDITIVE/ATTACH; null for CREATE/SKIP"),
  title: z.string().nullable().describe("Title for a CREATE, else null"),
  collection: z.string().nullable().describe("Collection name for a CREATE, else null"),
  confidence: z.number().min(0).max(1).describe("0-1 confidence this is the right action AND target"),
  rationale: z.string().describe("One or two sentences, in Mort's voice, on why"),
  // Semantic metadata — the model classifies; the code injects the deterministic
  // fields (source files, folder origin, tier, dates) around these.
  zone: z.array(z.string()).describe("Venue zones covered (e.g. Main Stage). Empty if not applicable."),
  system: z.array(z.string()).describe("Systems covered (Video, Audio, Lighting, Network…). Empty if not applicable."),
  docType: z.string().nullable().describe("Document type (How-to, Reference, Policy, Troubleshooting…) or null"),
  entities: z
    .array(z.string())
    .describe("Specific gear/rooms named in the content (grandMA3, LED wall, Milli machines). Empty if none."),
  bodyMarkdown: z
    .string()
    .describe(
      "The cleaned article body in markdown for CREATE/UPDATE_ADDITIVE. Do NOT include a metadata " +
        "header or an H1 title — Mort adds those. Empty for ATTACH/REVIEW/SKIP.",
    ),
});
export type Decision = z.infer<typeof decisionSchema>;

const INSTRUCTIONS = `You are taking a file into Mort's library and deciding what — if anything —
the knowledge base should do about it.

FIRST, always: write \`summary\` (what this file is) and classify zone/system/docType/entities
from the CONTENT. This is recorded whatever you decide, so Mort remembers the file and can
reference it later. Leave fields empty rather than guessing.

THEN judge: is this ARTICLE material or REFERENCE material?

- ARTICLE material documents how something works or is done — Word procedures, specs,
  written knowledge someone would READ.
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
- targetDocId MUST be one of the candidate doc ids listed below. Never invent one — if none
  fit, use CREATE or HOLD.
- You are shown the other files Mort already has. Use them: prefer the page that related
  files already feed, and reference those artifacts rather than duplicating their content.
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
  candidates: KbHit[];
  candidateBody?: string | null;
  /** Other files Mort already holds that look related — his library, not the KB. */
  relatedFiles?: RelatedFile[];
};

const MAX_INPUT = 40_000;

/** The decision plus what it cost — tokens feed the journal and the daily cap. */
export type DecideResult = { decision: Decision; tokens: number };

export async function decide(input: DecideInput): Promise<DecideResult> {
  const candidateList = input.candidates
    .map((c, i) => `  [${i}] docId=${c.docId} · ${c.title} (score ${c.score.toFixed(2)}) — ${c.breadcrumb}`)
    .join("\n");

  const relatedList = (input.relatedFiles ?? [])
    .map((f) => `  [${f.role}] ${f.sourceId} — ${f.summary ?? "(not yet summarised)"}`)
    .join("\n");

  const prompt = [
    `File: ${input.fileName}`,
    input.folderPath ? `Folder: ${input.folderPath}` : "",
    `Detected role: ${input.role}`,
    "",
    "Existing KB candidates (best first) — targetDocId must be one of these:",
    candidateList || "  (none — the KB has nothing similar)",
    "",
    "Other files already in Mort's library that look related:",
    relatedList || "  (none)",
    "",
    input.candidateBody ? `Current content of the top candidate:\n${input.candidateBody.slice(0, 8000)}` : "",
    "",
    "Extracted file content:",
    input.extractedMarkdown.slice(0, MAX_INPUT),
  ]
    .filter(Boolean)
    .join("\n");

  const { object, usage } = await generateObject({
    model: getModel(),
    schema: decisionSchema,
    maxRetries: 0,
    system: `${MORT_AUTHORING_PREAMBLE}\n\n${INSTRUCTIONS}`,
    prompt,
  });
  return { decision: object, tokens: usage?.totalTokens ?? 0 };
}
