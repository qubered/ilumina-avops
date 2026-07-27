import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel, Tool } from "ai";
import { env } from "../env";

/**
 * Codex CLI OAuth token reuse (pattern from qubered/health-tracker
 * lib/ai.ts). Sends your ChatGPT subscription OAuth token to the Codex
 * backend — the same credential the `codex` CLI uses. This is UNOFFICIAL:
 * it can break if OpenAI changes the endpoint, and it's outside OpenAI's
 * intended use. The API-key paths are the supported ones.
 *
 * Token freshness: the access token is a ~10-day JWT the codex CLI refreshes.
 * We read it fresh each request. If CODEX_AUTO_REFRESH=true, we refresh via
 * the refresh_token when it's near expiry and WRITE THE ROTATED TOKENS BACK
 * to auth.json (atomic tmp+rename), exactly like the codex CLI does.
 *
 * Writing back is load-bearing, not optional: OpenAI refresh tokens are
 * single-use. A refresh that isn't persisted burns the stored refresh token
 * and breaks both this app (on restart) and the codex CLI login itself.
 * (Learned the hard way — the original health-tracker pattern kept refreshes
 * in-memory only and eventually forced a `codex login` re-auth.)
 *
 * Deliberately isolated in its own module: only `model/chat.ts` (the
 * assistant's chat model) imports this. `model/ingest.ts` (the authoring
 * model) must NOT inherit this baggage — see its own header comment.
 */

export const SESSION_ID = randomUUID();
const CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = process.env.CODEX_OAUTH_TOKEN_URL || "https://auth.openai.com/oauth/token";

let cached: { token: string; expMs: number } | null = null;

function codexHome(): string {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

type CodexAuthFile = {
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
};

function readCodexAuthFile(): CodexAuthFile {
  let raw: { tokens?: CodexAuthFile };
  try {
    raw = JSON.parse(readFileSync(path.join(codexHome(), "auth.json"), "utf8"));
  } catch {
    throw new Error("Codex auth not found. Run `codex login`, or switch AI_PROVIDER.");
  }
  if (!raw?.tokens?.access_token) {
    throw new Error("No Codex access token in auth.json. Run `codex login`.");
  }
  return raw.tokens;
}

function jwtExpiryMs(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Persist rotated tokens back to auth.json (atomic), preserving other fields. */
function persistTokens(update: {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}): void {
  const file = path.join(codexHome(), "auth.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      tokens?: Record<string, unknown>;
      last_refresh?: string;
    };
    raw.tokens = {
      ...raw.tokens,
      access_token: update.access_token,
      ...(update.refresh_token ? { refresh_token: update.refresh_token } : {}),
      ...(update.id_token ? { id_token: update.id_token } : {}),
    };
    raw.last_refresh = new Date().toISOString();
    const tmp = `${file}.avops-tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    // Read-only mount or concurrent write: the refresh still worked for this
    // process, but warn loudly — an unpersisted rotation invalidates the
    // stored refresh token (they are single-use).
    console.warn(
      "[codex] could not persist rotated tokens to auth.json — the stored refresh token is now stale; ensure the file is writable:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error("Codex token refresh failed. Run `codex login` to re-authenticate.");
  }
  cached = {
    token: data.access_token,
    expMs: jwtExpiryMs(data.access_token) ?? Date.now() + 3_600_000,
  };
  persistTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    id_token: data.id_token,
  });
  return data.access_token;
}

export async function resolveCodexToken(): Promise<{ token: string; accountId: string | null }> {
  const file = readCodexAuthFile();
  const accountId = file.account_id ?? null;
  const now = Date.now();
  const buffer = 60_000;

  // Prefer a still-valid in-memory refreshed token.
  if (cached && cached.expMs > now + buffer) return { token: cached.token, accountId };

  const fileExp = jwtExpiryMs(file.access_token!);
  if (!fileExp || fileExp > now + buffer) return { token: file.access_token!, accountId };

  // File token is expired/near-expiry.
  if (env.CODEX_AUTO_REFRESH && file.refresh_token) {
    const token = await refreshAccessToken(file.refresh_token);
    return { token, accountId };
  }
  throw new Error(
    "Codex token expired. Run `codex` once (or `codex login`) to refresh it, or set CODEX_AUTO_REFRESH=true.",
  );
}

export type ChatStack = {
  model: LanguageModel;
  /** Provider-executed tools (web search), merged into the agent's toolset. */
  providerTools: Record<string, Tool>;
};
