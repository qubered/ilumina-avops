import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    AUTH_SECRET: z.string().min(32),
    COOKIE_DOMAIN: z.string().optional().default(""),
    // When set, registration requires this key (crew invite code). Leave
    // empty to allow open registration.
    SIGNUP_KEY: z.string().optional().default(""),
    // Chat model backend (see src/lib/rag/model.ts):
    //   anthropic  — Anthropic API (default)
    //   openai     — OpenAI Responses API (or a Responses-compatible endpoint)
    //   codex      — the Codex CLI's ChatGPT subscription login (~/.codex/auth.json)
    //   openrouter — OpenRouter (Chat Completions); free models available
    AI_PROVIDER: z
      .enum(["anthropic", "openai", "codex", "openrouter"])
      .default("anthropic"),
    // Provider-executed web search for general equipment/manufacturer info
    // (the KB stays the only authority for venue-specific facts).
    AI_WEB_SEARCH: z
      .string()
      .optional()
      .default("true")
      .transform((v) => v !== "false"),
    ANTHROPIC_API_KEY: z.string().optional().default(""),
    ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
    OPENAI_BASE_URL: z.string().optional().default(""),
    OPENAI_API_KEY: z.string().optional().default(""),
    OPENAI_MODEL: z.string().default("gpt-5.5"),
    CODEX_MODEL: z.string().default("gpt-5.5"),
    CODEX_BASE_URL: z.string().default("https://chatgpt.com/backend-api/codex"),
    CODEX_HOME: z.string().optional().default(""),
    CODEX_AUTO_REFRESH: z
      .string()
      .optional()
      .default("")
      .transform((v) => v === "true"),
    OPENROUTER_API_KEY: z.string().optional().default(""),
    // "openrouter/free" = OpenRouter's Free Models Router: picks a random
    // free, tool-capable model per request. Pin a specific slug for
    // consistency (e.g. meta-llama/llama-3.3-70b-instruct:free).
    OPENROUTER_MODEL: z.string().default("openrouter/free"),
    // Embeddings: "ollama" (default) runs a local model — no paid service,
    // no rate limits. "voyage" uses the Voyage API (needs VOYAGE_API_KEY).
    EMBEDDINGS_PROVIDER: z.enum(["ollama", "voyage"]).default("ollama"),
    OLLAMA_URL: z.string().url().default("http://localhost:11434"),
    EMBEDDINGS_MODEL: z.string().default("nomic-embed-text"),
    VOYAGE_API_KEY: z.string().optional().default(""),
    VOYAGE_MODEL: z.string().default("voyage-3-large"),
    QDRANT_URL: z.string().url().default("http://localhost:6333"),
    // When set, in-flight answers are resumable across tab close / reconnect
    // (Redis pub/sub via resumable-stream). Empty = poll-on-return fallback.
    REDIS_URL: z.string().optional().default(""),
    OUTLINE_URL: z.string().url(),
    OUTLINE_API_KEY: z.string().min(1),
    OUTLINE_WEBHOOK_SECRET: z.string().min(1),
    // Shared secret for internal service-to-service calls (Mort ingest → this
    // app's /api/internal/*). Empty = the internal endpoints refuse all callers.
    INTERNAL_API_KEY: z.string().optional().default(""),
    APP_URL: z.string().url().default("http://localhost:3000"),
    // OIDC client credentials for Outline SSO (this app is the identity
    // provider). When both are set, Outline is registered as a trusted client.
    OIDC_CLIENT_ID: z.string().optional().default(""),
    OIDC_CLIENT_SECRET: z.string().optional().default(""),
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "required when AI_PROVIDER=anthropic",
      });
    }
    if (env.AI_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "required when AI_PROVIDER=openai",
      });
    }
    if (env.AI_PROVIDER === "openrouter" && !env.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENROUTER_API_KEY"],
        message: "required when AI_PROVIDER=openrouter (get one at openrouter.ai/keys)",
      });
    }
    if (env.EMBEDDINGS_PROVIDER === "voyage" && !env.VOYAGE_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["VOYAGE_API_KEY"],
        message: "required when EMBEDDINGS_PROVIDER=voyage",
      });
    }
    // codex mode needs no env secrets — ~/.codex/auth.json is read at
    // request time with a clear error if missing/expired.
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Validate and return the environment. Lazy so `next build` succeeds without
 * secrets; `instrumentation.ts` calls this at server boot to fail fast.
 */
export function getEnv(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Property-level lazy access: `env.DATABASE_URL` validates on first touch. */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return getEnv()[prop as keyof Env];
  },
});
