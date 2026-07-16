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
  regionBody: z
    .string()
    .describe(
      "Content for Mort's region on CREATE/UPDATE_ADDITIVE: the Key:value metadata header " +
        "(Zone/System/Type…) then the cleaned markdown body. Empty for ATTACH/REVIEW/SKIP.",
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
- For CREATE/UPDATE_ADDITIVE, regionBody starts with a Key:value metadata header (blank-line separated), e.g.
  "Zone: Main Stage\\n\\nSystem: Lighting\\n\\nType: Procedure", then the cleaned body. Never invent facts.`;

export type DecideInput = {
  fileName: string;
  folderPath?: string;
  role: FileRole;
  extractedMarkdown: string;
  candidates: KbHit[];
  candidateBody?: string | null;
};

const MAX_INPUT = 40_000;

export async function decide(input: DecideInput): Promise<Decision> {
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

  const { object } = await generateObject({
    model: getModel(),
    schema: decisionSchema,
    maxRetries: 0,
    system: `${MORT_AUTHORING_PREAMBLE}\n\n${INSTRUCTIONS}`,
    prompt,
  });
  return object;
}
