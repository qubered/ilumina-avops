import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { env } from "./env.js";

function getModel(): LanguageModel {
  if (env.INGEST_AI_PROVIDER === "anthropic") return anthropic(env.ANTHROPIC_MODEL);
  if (env.INGEST_AI_PROVIDER === "openai") {
    const openai = createOpenAI({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL || undefined,
    });
    return openai.chat(env.OPENAI_MODEL);
  }
  const openrouter = createOpenAI({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: env.OPENROUTER_API_KEY,
    headers: env.APP_URL
      ? { "HTTP-Referer": env.APP_URL, "X-Title": "ILUMINA AV Ops Ingest" }
      : undefined,
  });
  return openrouter.chat(env.OPENROUTER_MODEL);
}

const outputSchema = z.object({
  title: z.string().describe("Concise, descriptive article title"),
  collectionName: z
    .string()
    .describe("The best-fitting collection from the provided list, or a concise new name if none fit"),
  zone: z.string().describe("Comma-separated venue zones, or 'N/A'"),
  system: z.string().describe("Comma-separated systems (Video, Audio, Network, …), or 'N/A'"),
  docType: z.string().describe("Document type (How-to, Reference, Policy, Troubleshooting, …)"),
  bodyMarkdown: z
    .string()
    .describe("The cleaned article body in markdown. Do NOT include the title as an H1 or the Zone/System/Type lines."),
});

export type NormalisedArticle = z.infer<typeof outputSchema>;

const MAX_INPUT_CHARS = 40_000;

const SYSTEM_PROMPT = `You normalise raw documents into clean knowledge-base articles for the
ILUMINA AV Operations wiki (venue AV crew — video, audio, lighting, networking,
rigging, power, staging, venue procedures).

Rewrite the content into a well-structured markdown article:
- Clear headings; numbered steps for procedures; markdown tables for tabular data.
- Keep every image placeholder token (looks like attachment://0) exactly where
  it belongs in the flow — never remove, renumber, or invent these tokens.
- Preserve all real operational detail (patch numbers, IPs, settings, part
  names). Do not invent facts; if the source is thin, keep the article short.
- Neutral, instructional tone. No preamble, no "this document describes…".

Also classify the article:
- Pick collectionName from the provided list of existing collections if one
  fits; only propose a new name if none is a reasonable home.
- zone/system/docType: short comma-separated values (or "N/A").`;

export async function normalise(input: {
  fileName: string;
  folderPath?: string;
  markdown: string;
  collections: string[];
  imageTokens: string[];
}): Promise<NormalisedArticle> {
  const truncated = input.markdown.slice(0, MAX_INPUT_CHARS);
  const truncNote =
    input.markdown.length > MAX_INPUT_CHARS ? "\n\n[content truncated for length]" : "";

  const { object } = await generateObject({
    model: getModel(),
    schema: outputSchema,
    system: SYSTEM_PROMPT,
    prompt: [
      `Source file: ${input.fileName}`,
      input.folderPath ? `SharePoint folder: ${input.folderPath}` : "",
      `Existing collections: ${input.collections.join(", ") || "(none)"}`,
      input.imageTokens.length
        ? `Image tokens that MUST appear in the body: ${input.imageTokens.join(", ")}`
        : "This document has no images.",
      "",
      "Raw content:",
      truncated + truncNote,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  return object;
}
