import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  defaultSettingsMiddleware,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
  type Tool,
} from "ai";
import { env } from "../env";
import { resolveCodexToken, SESSION_ID, type ChatStack } from "./shared";

export type { ChatStack };

/**
 * The assistant's chat model provider selection:
 *
 *   AI_PROVIDER=anthropic  Anthropic API (default) — ANTHROPIC_API_KEY
 *   AI_PROVIDER=openai     OpenAI or any OpenAI-compatible endpoint —
 *                          OPENAI_API_KEY (+ optional OPENAI_BASE_URL)
 *   AI_PROVIDER=codex      Reuse the Codex CLI's ChatGPT login
 *                          (~/.codex/auth.json). No API key needed.
 *   AI_PROVIDER=openrouter OpenRouter (Chat Completions)
 */

/**
 * The configured chat model plus its provider-executed web-search tool
 * (DESIGN: KB is the only authority for venue facts; the web covers general
 * equipment/manufacturer info). Throws with a human-readable message when
 * the provider is misconfigured (callers surface it as a 503, never a hang).
 */
export async function getChatStack(): Promise<ChatStack> {
  // OpenRouter: OpenAI-compatible, but the Chat Completions dialect (.chat),
  // not the Responses API. No provider-executed web search (that's
  // Responses-only) — kb_search still grounds every answer. The system
  // prompt goes as a normal message via systemPromptOptions().
  if (env.AI_PROVIDER === "openrouter") {
    const openrouter = createOpenAI({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: env.OPENROUTER_API_KEY,
      headers: {
        // Optional attribution shown on the OpenRouter dashboard.
        "HTTP-Referer": env.APP_URL || "http://localhost:3000",
        "X-Title": "ILUMINA AV Ops",
      },
    });
    return { model: openrouter.chat(env.OPENROUTER_MODEL), providerTools: {} };
  }

  if (env.AI_PROVIDER === "codex" || env.AI_PROVIDER === "openai") {
    const openai =
      env.AI_PROVIDER === "codex"
        ? await (async () => {
            const { token, accountId } = await resolveCodexToken();
            return createOpenAI({
              name: "codex",
              baseURL: env.CODEX_BASE_URL,
              apiKey: token,
              headers: {
                "chatgpt-account-id": accountId ?? "",
                "OpenAI-Beta": "responses=experimental",
                originator: "codex_cli_rs",
                session_id: SESSION_ID,
              },
            });
          })()
        : createOpenAI({
            apiKey: env.OPENAI_API_KEY,
            baseURL: env.OPENAI_BASE_URL || undefined,
          });

    const providerTools: Record<string, Tool> = env.AI_WEB_SEARCH
      ? { web_search: openai.tools.webSearch({}) }
      : {};

    if (env.AI_PROVIDER === "openai") {
      return { model: openai.responses(env.OPENAI_MODEL || "gpt-5.5"), providerTools };
    }

    // The Codex backend is strict: it requires `store: false` and rejects
    // standard sampling/limit params ("Unsupported parameter:
    // max_output_tokens"). Bake both into the model so call sites stay
    // provider-agnostic.
    const stripUnsupportedParams: LanguageModelMiddleware = {
      transformParams: async ({ params }) => ({
        ...params,
        maxOutputTokens: undefined,
        temperature: undefined,
        topP: undefined,
        frequencyPenalty: undefined,
        presencePenalty: undefined,
      }),
    };
    return {
      model: wrapLanguageModel({
        model: openai.responses(env.CODEX_MODEL),
        middleware: [
          stripUnsupportedParams,
          defaultSettingsMiddleware({
            settings: { providerOptions: { openai: { store: false } } },
          }),
        ],
      }),
      providerTools,
    };
  }

  return {
    model: anthropic(env.ANTHROPIC_MODEL),
    providerTools: env.AI_WEB_SEARCH
      ? { web_search: anthropic.tools.webSearch_20250305({ maxUses: 3 }) }
      : {},
  };
}

/** Model only — for single-shot calls like title generation. */
export async function getChatModel(): Promise<LanguageModel> {
  return (await getChatStack()).model;
}

/**
 * Provider-correct way to pass the system prompt. The Codex backend (and the
 * OpenAI Responses API) take it as a top-level `instructions` field via
 * providerOptions; Anthropic takes a plain `system` param. `store: false`
 * keeps conversations out of OpenAI's server-side storage.
 */
export function systemPromptOptions(system: string):
  | { system: string }
  | { providerOptions: { openai: { instructions: string; store: false } } } {
  if (env.AI_PROVIDER === "codex" || env.AI_PROVIDER === "openai") {
    return { providerOptions: { openai: { instructions: system, store: false } } };
  }
  return { system };
}
