import { z } from "zod";

const schema = z
  .object({
    PORT: z.coerce.number().default(8080),
    // Bearer token Power Automate must send (Authorization: Bearer <key>).
    INGEST_API_KEY: z.string().min(1),

    // Same Outline + Postgres the assistant uses.
    OUTLINE_URL: z.string().url(),
    OUTLINE_API_KEY: z.string().min(1),
    DATABASE_URL: z.string().min(1),

    // AI for normalisation. Defaults to the stack's provider; codex isn't
    // supported here (its file-mount auth is assistant-specific) — use an
    // API-key provider for ingestion.
    INGEST_AI_PROVIDER: z.enum(["openrouter", "openai", "anthropic"]).default("openrouter"),
    OPENROUTER_API_KEY: z.string().optional().default(""),
    OPENROUTER_MODEL: z.string().default("openrouter/free"),
    OPENAI_API_KEY: z.string().optional().default(""),
    OPENAI_BASE_URL: z.string().optional().default(""),
    OPENAI_MODEL: z.string().default("gpt-4o"),
    ANTHROPIC_API_KEY: z.string().optional().default(""),
    ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),

    // Fallback collection name if the AI can't pick a fitting section.
    INGEST_DEFAULT_COLLECTION: z.string().default("Imported"),
    APP_URL: z.string().optional().default(""),

    // Mort → assistant internal KB search (v1.5). Empty ASSISTANT_KB_URL = Mort
    // runs without KB context (graceful degradation, never a hard failure).
    ASSISTANT_KB_URL: z.string().optional().default(""),
    // Assistant endpoint that embeds + indexes event rows into Qdrant (R1).
    ASSISTANT_EVENTS_INDEX_URL: z.string().optional().default(""),
    INTERNAL_API_KEY: z.string().optional().default(""),

    // Mort authoring mode. off = legacy one-file-one-article pipeline (unchanged).
    // shadow = Mort decides but only PROPOSES to the review queue (no live writes).
    // live = Mort executes confident create/update; everything else → review.
    MORT_MODE: z.enum(["off", "shadow", "live"]).default("off"),
    MORT_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  })
  .superRefine((env, ctx) => {
    const need = (cond: boolean, path: string, message: string) => {
      if (cond) ctx.addIssue({ code: "custom", path: [path], message });
    };
    need(env.INGEST_AI_PROVIDER === "openrouter" && !env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY", "required for openrouter");
    need(env.INGEST_AI_PROVIDER === "openai" && !env.OPENAI_API_KEY, "OPENAI_API_KEY", "required for openai");
    need(env.INGEST_AI_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY", "required for anthropic");
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid ingest environment:\n${issues}`);
}

export const env = parsed.data;
