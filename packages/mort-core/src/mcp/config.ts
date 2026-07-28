import { z } from "zod";
import { serverNameError } from "./naming";

/**
 * What a registered MCP server's `config` column may contain, and how its
 * secrets are handled (MORT_V2_PLAN I.5).
 *
 * The rule the plan states in half a line — "secrets via env refs, not
 * literals" — is enforced here, at the point config is written, because the
 * admin UI reads these rows back and a token pasted into a jsonb column is a
 * token in every screenshot, backup and `SELECT *` from then on. A value
 * written `env:VENUE_PDU_TOKEN` is stored as that string and resolved from the
 * process environment at connect time; a literal in a field whose name reads
 * like a credential is refused with an error that says what to write instead.
 */

export type McpTransportKind = "stdio" | "sse" | "streamable-http";

export const TRANSPORTS: McpTransportKind[] = ["stdio", "sse", "streamable-http"];

/** `env:NAME` — the only form a secret may take in a stored config. */
const ENV_REF = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Header and env keys that must never hold a literal. Substring matching on
 * purpose: `X-Api-Key`, `PDU_PASSWORD` and `authorization` all have to trip it,
 * and a false positive costs an admin one `env:` prefix while a false negative
 * costs a leaked credential.
 */
const SECRET_KEY = /(auth|token|key|secret|password|passwd|credential|cookie|bearer)/i;

const httpConfig = z.object({
  url: z.string().url("A URL transport needs a full http(s) URL."),
  headers: z.record(z.string(), z.string()).optional(),
});

const stdioConfig = z.object({
  command: z.string().min(1, "A stdio transport needs a command to run."),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

export type HttpConfig = z.infer<typeof httpConfig>;
export type StdioConfig = z.infer<typeof stdioConfig>;
export type McpConfig = HttpConfig | StdioConfig;

export function isStdio(transport: McpTransportKind): boolean {
  return transport === "stdio";
}

/**
 * Parse and vet a config for a transport. Throws with an admin-readable
 * message — every caller is either an admin API route or the registry, and
 * both want the sentence rather than a Zod tree.
 */
export function parseMcpConfig(transport: McpTransportKind, raw: unknown): McpConfig {
  const schema = isStdio(transport) ? stdioConfig : httpConfig;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Named by field: "expected string, received undefined" is useless on its
    // own to whoever has to fix the JSON in the panel.
    throw new Error(
      parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; "),
    );
  }
  const config = parsed.data;
  // Both halves of a config carry credentials — a stdio server's env and an
  // HTTP server's headers — and the rule is the same for both.
  const secrets: Record<string, string> = ("command" in config ? config.env : config.headers) ?? {};
  for (const [key, value] of Object.entries(secrets)) {
    if (SECRET_KEY.test(key) && !ENV_REF.test(value)) {
      throw new Error(
        `“${key}” looks like a credential, so it can't be stored here literally. Put the value in the server's environment and reference it as env:VARIABLE_NAME.`,
      );
    }
  }
  return config;
}

/**
 * Swap `env:NAME` references for their values, at connect time and nowhere
 * else. A missing variable throws rather than connecting with the literal
 * string `env:NAME` as a bearer token — which would fail anyway, but as a 401
 * from someone else's server rather than as our own clear message.
 */
export function resolveRefs(values: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const ref = ENV_REF.exec(value);
    if (!ref) {
      out[key] = value;
      continue;
    }
    const resolved = process.env[ref[1]];
    if (!resolved) {
      throw new Error(`${key} references env:${ref[1]}, which is not set in this service's environment.`);
    }
    out[key] = resolved;
  }
  return out;
}

/**
 * The config as it is safe to show an admin: env refs stay as refs (they name
 * a variable, not a value) and anything else in a secret-shaped key is masked.
 * Belt and braces — parseMcpConfig should have refused to store such a value —
 * but rows predating a rule are exactly what an admin panel renders.
 */
export function redactConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if ((key === "headers" || key === "env") && value && typeof value === "object") {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, string>).map(([k, v]) => [
          k,
          SECRET_KEY.test(k) && !ENV_REF.test(v) ? "••••" : v,
        ]),
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Validate a whole registration in one go, the way an API route wants it. */
export function validateRegistration(input: {
  name: string;
  transport: string;
  config: unknown;
}): { name: string; transport: McpTransportKind; config: McpConfig } {
  const nameError = serverNameError(input.name);
  if (nameError) throw new Error(nameError);
  if (!(TRANSPORTS as string[]).includes(input.transport)) {
    throw new Error(`Unknown transport '${input.transport}' — use one of ${TRANSPORTS.join(", ")}.`);
  }
  const transport = input.transport as McpTransportKind;
  return { name: input.name, transport, config: parseMcpConfig(transport, input.config) };
}
