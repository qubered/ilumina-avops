import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    AUTH_SECRET: z.string().min(32),
    COOKIE_DOMAIN: z.string().optional().default(""),
    // Chat model backend (see src/lib/rag/model.ts):
    //   anthropic — Anthropic API (default)
    //   openai    — OpenAI or any OpenAI-compatible endpoint, with an API key
    //   codex     — the Codex CLI's ChatGPT subscription login (~/.codex/auth.json)
    AI_PROVIDER: z.enum(["anthropic", "openai", "codex"]).default("anthropic"),
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
    VOYAGE_API_KEY: z.string().min(1),
    VOYAGE_MODEL: z.string().default("voyage-3-large"),
    QDRANT_URL: z.string().url().default("http://localhost:6333"),
    OUTLINE_URL: z.string().url(),
    OUTLINE_API_KEY: z.string().min(1),
    OUTLINE_WEBHOOK_SECRET: z.string().min(1),
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
