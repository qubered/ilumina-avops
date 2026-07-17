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
  action: z.enum(["CREATE", "UPDATE_ADDITIVE", "ATTACH", "REVIEW", "SKIP"]),
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

const INSTRUCTIONS = `You decide how ONE incoming file should change the knowledge base. Choose:
- CREATE: no existing doc covers this — make a new one (give title + collection).
- UPDATE_ADDITIVE: a candidate doc is the right home — add/refresh Mort's region there (give targetDocId).
- ATTACH: a reference/show file that belongs on an existing doc as a downloadable artifact (give targetDocId).
- REVIEW: you want to merge, restructure, overwrite, or you are unsure which candidate is right — propose for a human.
- SKIP: nothing to do (duplicate, empty, irrelevant).

Rules:
- One file does NOT mean one page. Prefer updating/attaching to the right existing doc over creating near-duplicates.
- 'reference'/'media' roles are usually ATTACH, not CREATE. 'truth'/'structured' usually CREATE or UPDATE_ADDITIVE.
- Set confidence honestly. If the best candidate is a weak match, lower confidence (it will be sent to review).
- Classify zone/system/docType/entities from the CONTENT. Leave them empty rather than guessing.
- bodyMarkdown is the cleaned body ONLY — no metadata header, no H1 title (Mort renders those himself
  from your classification plus facts he already knows). Never invent facts.`;

export type DecideInput = {
  fileName: string;
  folderPath?: string;
  role: FileRole;
  extractedMarkdown: string;
  candidates: KbHit[];
  candidateBody?: string | null;
};

const MAX_INPUT = 40_000;

/** The decision plus what it cost — tokens feed the journal and the daily cap. */
export type DecideResult = { decision: Decision; tokens: number };

export async function decide(input: DecideInput): Promise<DecideResult> {
  const candidateList = input.candidates
    .map((c, i) => `  [${i}] docId=${c.docId} · ${c.title} (score ${c.score.toFixed(2)}) — ${c.breadcrumb}`)
    .join("\n");

  const prompt = [
    `File: ${input.fileName}`,
    input.folderPath ? `Folder: ${input.folderPath}` : "",
    `Detected role: ${input.role}`,
    "",
    "Existing KB candidates (best first):",
    candidateList || "  (none — the KB has nothing similar)",
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
