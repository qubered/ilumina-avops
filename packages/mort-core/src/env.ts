import { z } from "zod";

/**
 * Lenient, all-optional env schema for shared core code (model/memory/kb).
 * Core is imported by both apps and must not force either one to supply
 * variables only the other needs — each app's own env.ts still hard-validates
 * what THAT service requires (DATABASE_URL, AUTH_SECRET, INGEST_API_KEY,
 * etc.) and fails fast at boot. This module just reads process.env directly
 * with sane defaults so shared code works regardless of which app wired it.
 */
const schema = z.object({
  DATABASE_URL: z.string().optional().default(""),

  OUTLINE_URL: z.string().optional().default(""),
  OUTLINE_API_KEY: z.string().optional().default(""),

  QDRANT_URL: z.string().url().default("http://localhost:6333"),

  EMBEDDINGS_PROVIDER: z.enum(["ollama", "voyage"]).default("ollama"),
  OLLAMA_URL: z.string().url().default("http://localhost:11434"),
  EMBEDDINGS_MODEL: z.string().default("nomic-embed-text"),
  VOYAGE_API_KEY: z.string().optional().default(""),
  VOYAGE_MODEL: z.string().default("voyage-3-large"),

  // Chat model (assistant).
  AI_PROVIDER: z.enum(["anthropic", "openai", "codex", "openrouter"]).default("anthropic"),
  AI_WEB_SEARCH: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v !== "false"),
  CODEX_MODEL: z.string().default("gpt-5.5"),
  CODEX_BASE_URL: z.string().default("https://chatgpt.com/backend-api/codex"),
  CODEX_HOME: z.string().optional().default(""),
  CODEX_AUTO_REFRESH: z
    .string()
    .optional()
    .default("")
    .transform((v) => v === "true"),

  // Authoring model (ingest).
  INGEST_AI_PROVIDER: z.enum(["openrouter", "openai", "anthropic"]).default("openrouter"),

  // Shared across both model selectors.
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_BASE_URL: z.string().optional().default(""),
  // No default here — the assistant's chat model and ingest's authoring
  // model had different OPENAI_MODEL defaults ("gpt-5.5" vs "gpt-4o"); each
  // model/*.ts applies its own fallback so neither app's behavior changes
  // for callers that don't set OPENAI_MODEL explicitly.
  OPENAI_MODEL: z.string().optional().default(""),
  OPENROUTER_API_KEY: z.string().optional().default(""),
  OPENROUTER_MODEL: z.string().default("openrouter/free"),

  // No default — the assistant always had one ("http://localhost:3000") and
  // treats it as always-present, while ingest defaults to "" and treats
  // empty as "omit the attribution header". Each model/*.ts applies its own
  // fallback below so neither app's original behavior changes.
  APP_URL: z.string().optional().default(""),

  // Mort mode/rails — settable from either service's compose block; DB
  // settings (mort_settings) are the effective source of truth, this is
  // just the env-level default read when no DB row exists yet.
  MORT_MODE: z.enum(["off", "shadow", "live"]).default("off"),
  MORT_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  MORT_DAILY_TOKEN_CAP: z.coerce.number().min(0).default(0),

  // Fallback collection name if the AI can't pick a fitting section.
  INGEST_DEFAULT_COLLECTION: z.string().default("Imported"),
});

export type CoreEnv = z.infer<typeof schema>;

let cached: CoreEnv | null = null;

function getEnv(): CoreEnv {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export const env: CoreEnv = new Proxy({} as CoreEnv, {
  get(_target, prop: string) {
    return getEnv()[prop as keyof CoreEnv];
  },
});
