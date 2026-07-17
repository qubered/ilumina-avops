import { generateObject } from "ai";
import { z } from "zod";
import { MORT_AUTHORING_PREAMBLE } from "./identity.js";
import { getModel, modelLabel } from "./model.js";
import { withRateLimitRetry } from "../ratelimit.js";
import type { FileRole } from "./types.js";

/**
 * Pass 1 of a Mort turn (MORT_PLAN §R7): read the file and say what it IS —
 * nothing about what the KB should do with it.
 *
 * This exists to break a chicken-and-egg. Retrieval wants the file's facets
 * (system, entities, zone) to find related pages and related files; but until
 * R7 those facets were only produced by the decision itself, so retrieval ran
 * on folder+filename alone and the decision was made half-blind — a schematic
 * in Video/ was invisible when authoring from a file in Lighting/, even when
 * both were about the same LED wall.
 *
 * Understanding first, retrieval second, decision third.
 *
 * The schema is deliberately tiny. Structured output is where small/cheap
 * models fall over, and this call runs on every file, so it must be the most
 * reliable call Mort makes.
 */

export const understandingSchema = z.object({
  summary: z
    .string()
    .describe(
      "One line: what this file IS (e.g. 'grandMA3 show file for Main Stage, v4', " +
        "'Word procedure for E2 camera patching'). This goes in Mort's library so he can " +
        "find and reference the file later, even if it never becomes an article.",
    ),
  zone: z.array(z.string()).describe("Venue zones this concerns (e.g. Main Stage). Empty if not applicable."),
  system: z
    .array(z.string())
    .describe("Systems this concerns (Video, Audio, Lighting, Network…). Empty if not applicable."),
  entities: z
    .array(z.string())
    .describe("Specific gear/rooms named in the content (grandMA3, LED wall, Milli machines). Empty if none."),
  docType: z.string().nullable().describe("Document type (How-to, Reference, Policy, Troubleshooting…) or null"),
});

export type Understanding = z.infer<typeof understandingSchema>;

const INSTRUCTIONS = `Read this file and say what it IS. Nothing else — you are not deciding what the
knowledge base should do with it, and you are not writing any documentation. That comes later,
once Mort has used your answer to pull up everything related.

Classify from the CONTENT, not the filename — filenames routinely lie.

Your zone/system/entities are what Mort searches with, so they matter more than they look:
name the specific gear and rooms the content actually mentions. "LED wall" or "grandMA3" will
find the right pages and the right sibling files. Vague or invented terms will find the wrong
ones, which is worse than none.

Leave a field empty rather than guessing at it.`;

/** How much of the file the understanding pass reads. Less than decide() gets:
 *  identifying a file rarely needs its tail, and this call runs on everything. */
const MAX_INPUT = 12_000;

export type UnderstandInput = {
  fileName: string;
  folderPath?: string;
  role: FileRole;
  extractedMarkdown: string;
};

export type UnderstandResult = { understanding: Understanding; tokens: number };

export async function understand(input: UnderstandInput): Promise<UnderstandResult> {
  const prompt = [
    `File: ${input.fileName}`,
    input.folderPath ? `Folder: ${input.folderPath}` : "",
    `Detected role: ${input.role}`,
    "",
    "Content:",
    input.extractedMarkdown.slice(0, MAX_INPUT) || "(no extractable text — judge from the name and role alone)",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { object, usage } = await withRateLimitRetry(() =>
      generateObject({
        model: getModel(),
        schema: understandingSchema,
        maxRetries: 2,
        system: `${MORT_AUTHORING_PREAMBLE}\n\n${INSTRUCTIONS}`,
        prompt,
      }),
    );
    return { understanding: object, tokens: usage?.totalTokens ?? 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fail here rather than degrading to a filename-only understanding. This is
    // the cheapest, smallest-schema call in the turn: if a model can't manage
    // it, it has no chance at the decision, and failing now avoids paying for
    // the retrieval and the decide call before finding that out.
    if (/no object generated|could not parse|did not return a response|invalid json|provider returned error/i.test(msg)) {
      throw new Error(
        `${msg} — ${modelLabel()} could not describe ${input.fileName}. This is the model, not the file: ` +
          `even Mort's simplest structured call is failing. Point INGEST_AI_PROVIDER/INGEST_MODEL at a ` +
          `capable model (e.g. openai + gpt-4o-mini, or anthropic + claude-sonnet-5). See ingest/README.md.`,
      );
    }
    throw err;
  }
}
