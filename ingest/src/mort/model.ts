import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "../env.js";

/**
 * Mort's own model selector (NOT the assistant's rag/model.ts — that carries
 * Codex-OAuth baggage Mort must not inherit, per review §15.7). Same providers
 * the existing normalise pipeline uses.
 */
/** The configured model's name — for logs and error messages. */
export function modelLabel(): string {
  if (env.INGEST_AI_PROVIDER === "anthropic") return `anthropic/${env.ANTHROPIC_MODEL}`;
  if (env.INGEST_AI_PROVIDER === "openai") return `openai/${env.OPENAI_MODEL}`;
  return `openrouter/${env.OPENROUTER_MODEL}`;
}

export function getModel(): LanguageModel {
  if (env.INGEST_AI_PROVIDER === "anthropic") return anthropic(env.ANTHROPIC_MODEL);
  if (env.INGEST_AI_PROVIDER === "openai") {
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL || undefined });
    return openai.chat(env.OPENAI_MODEL);
  }
  const openrouter = createOpenAI({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: env.OPENROUTER_API_KEY,
    headers: env.APP_URL ? { "HTTP-Referer": env.APP_URL, "X-Title": "ILUMINA AV Ops · Mort" } : undefined,
  });
  return openrouter.chat(env.OPENROUTER_MODEL);
}
