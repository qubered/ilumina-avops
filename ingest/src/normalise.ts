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
const RATE_LIMIT_ATTEMPTS = 4;

/** Dig through the AI SDK error graph for a 429 and its Retry-After seconds. */
function rateLimitInfo(err: unknown): { is429: boolean; retryAfterSec: number } {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length) {
    const e = stack.pop() as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const body = String((e as { responseBody?: unknown }).responseBody ?? "");
    if ((e as { statusCode?: number }).statusCode === 429 || /"code":\s*429|429/.test(body)) {
      const headers = (e as { responseHeaders?: Record<string, string> }).responseHeaders;
      const fromHeader = Number(headers?.["retry-after"]);
      let fromBody: number | undefined;
      try {
        fromBody = JSON.parse(body)?.error?.metadata?.retry_after_seconds;
      } catch {
        /* body not JSON */
      }
      const sec = [fromHeader, fromBody].find((v) => Number.isFinite(v) && (v as number) > 0);
      return { is429: true, retryAfterSec: (sec as number) ?? 15 };
    }
    for (const key of ["lastError", "cause"]) {
      if ((e as Record<string, unknown>)[key]) stack.push((e as Record<string, unknown>)[key]);
    }
    if (Array.isArray((e as { errors?: unknown[] }).errors)) {
      stack.push(...((e as { errors: unknown[] }).errors));
    }
  }
  return { is429: false, retryAfterSec: 0 };
}

/** Free models get transiently rate-limited; wait out the server's Retry-After. */
async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const { is429, retryAfterSec } = rateLimitInfo(err);
      if (!is429 || attempt >= RATE_LIMIT_ATTEMPTS) throw err;
      const wait = Math.min(retryAfterSec + 2, 35);
      console.warn(`[ingest] rate-limited, waiting ${wait}s (attempt ${attempt}/${RATE_LIMIT_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

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

  const { object } = await withRateLimitRetry(() =>
    generateObject({
      model: getModel(),
      schema: outputSchema,
      // We handle rate-limit waits ourselves (honoring Retry-After); the
      // SDK's fast internal retries just burn attempts on a 429.
      maxRetries: 0,
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
    }),
  );

  return object;
}
