import { pool } from "../memory/db";
import type { ToolTier } from "../tools/policy";
import { parseMcpConfig, validateRegistration, type McpConfig, type McpTransportKind } from "./config";

/**
 * The MCP server registry (MORT_V2_PLAN I.5) — storage only, no connections
 * and no policy. `mort_mcp_servers` is the config half of "Mort controls
 * stuff": a console or PDU that speaks MCP becomes a row here rather than a
 * code change.
 *
 * Two defaults do the safety work and both live in the DDL rather than here:
 * a new row is `enabled = false` (registering arms nothing) and
 * `default_tier = 'write:world'` (its tools are treated as able to do anything
 * until an admin downgrades a NAMED tool).
 */

/**
 * The tiers an admin may put an MCP tool on. `write:world` is the default and
 * means confirm-first, admin-only; `read` is the deliberate downgrade for a
 * tool that genuinely only reports (a lamp-hours query, a rack temperature).
 * The KB and memory tiers are absent on purpose — an external tool doesn't
 * write Mort's memory or the wiki, and offering the choice would only invite
 * someone to mislabel one.
 */
export const MCP_TIERS = ["read", "write:world"] as const;
export type McpTier = (typeof MCP_TIERS)[number];

export function isMcpTier(v: unknown): v is McpTier {
  return typeof v === "string" && (MCP_TIERS as readonly string[]).includes(v);
}

export type McpToolOverride = {
  tier?: McpTier;
  /** Leave a specific tool off the belt without disabling the whole server. */
  enabled?: boolean;
};

export type McpServerRow = {
  name: string;
  transport: McpTransportKind;
  config: McpConfig;
  enabled: boolean;
  defaultTier: McpTier;
  toolOverrides: Record<string, McpToolOverride>;
  /** Tool-definition digests an admin has seen — the drift baseline. */
  fingerprints: Record<string, string>;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

const COLS = `name, transport, config, enabled, default_tier, tool_overrides, fingerprints, description, created_at, updated_at`;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapRow(r: Record<string, unknown>): McpServerRow {
  const transport = r.transport as McpTransportKind;
  return {
    name: r.name as string,
    transport,
    // Rows are written through parseMcpConfig, but a hand-edited row shouldn't
    // take the whole belt down: fall back to the raw jsonb and let the connect
    // attempt produce the readable error instead.
    config: safeConfig(transport, r.config),
    enabled: Boolean(r.enabled),
    defaultTier: isMcpTier(r.default_tier) ? r.default_tier : "write:world",
    toolOverrides: (r.tool_overrides as Record<string, McpToolOverride>) ?? {},
    fingerprints: (r.fingerprints as Record<string, string>) ?? {},
    description: (r.description as string) ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function safeConfig(transport: McpTransportKind, raw: unknown): McpConfig {
  try {
    return parseMcpConfig(transport, raw);
  } catch {
    return (raw as McpConfig) ?? ({} as McpConfig);
  }
}

export async function listMcpServers(): Promise<McpServerRow[]> {
  const { rows } = await pool.query(`SELECT ${COLS} FROM mort_mcp_servers ORDER BY name`);
  return rows.map(mapRow);
}

export async function listEnabledMcpServers(): Promise<McpServerRow[]> {
  const { rows } = await pool.query(`SELECT ${COLS} FROM mort_mcp_servers WHERE enabled ORDER BY name`);
  return rows.map(mapRow);
}

export async function getMcpServer(name: string): Promise<McpServerRow | null> {
  const { rows } = await pool.query(`SELECT ${COLS} FROM mort_mcp_servers WHERE name = $1`, [name]);
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * Register or reconfigure a server. Never touches `enabled`: re-registering an
 * already-running server changes how Mort connects to it, not whether he does
 * — arming is always its own deliberate act.
 */
export async function upsertMcpServer(input: {
  name: string;
  transport: string;
  config: unknown;
  description?: string | null;
  defaultTier?: McpTier;
}): Promise<McpServerRow> {
  const { name, transport, config } = validateRegistration(input);
  const tier: McpTier = input.defaultTier ?? "write:world";
  const { rows } = await pool.query(
    `INSERT INTO mort_mcp_servers (name, transport, config, default_tier, description)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (name) DO UPDATE
       SET transport = EXCLUDED.transport,
           config = EXCLUDED.config,
           default_tier = EXCLUDED.default_tier,
           description = EXCLUDED.description,
           -- A reconfigured server is a different server as far as trust goes:
           -- drop the drift baseline so its tools are re-fingerprinted and any
           -- change is shown to whoever enables it next.
           fingerprints = '{}'::jsonb,
           updated_at = now()
     RETURNING ${COLS}`,
    [name, transport, JSON.stringify(config), tier, input.description ?? null],
  );
  return mapRow(rows[0]);
}

export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<McpServerRow | null> {
  const { rows } = await pool.query(
    `UPDATE mort_mcp_servers SET enabled = $2, updated_at = now() WHERE name = $1 RETURNING ${COLS}`,
    [name, enabled],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * Override one tool: its tier, whether it's on the belt, or both. Merged into
 * the existing jsonb rather than replacing it, so two admins tuning different
 * tools on the same server don't clobber each other.
 */
export async function setMcpToolOverride(
  name: string,
  tool: string,
  override: McpToolOverride,
): Promise<McpServerRow | null> {
  const { rows } = await pool.query(
    `UPDATE mort_mcp_servers
        SET tool_overrides = tool_overrides || jsonb_build_object($2::text, (tool_overrides -> $2::text) || $3::jsonb),
            updated_at = now()
      WHERE name = $1
      RETURNING ${COLS}`,
    [name, tool, JSON.stringify(override)],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/** Record the tool digests an admin has now seen — clears the drift flag. */
export async function recordMcpFingerprints(
  name: string,
  fingerprints: Record<string, string>,
): Promise<void> {
  await pool.query(`UPDATE mort_mcp_servers SET fingerprints = $2::jsonb, updated_at = now() WHERE name = $1`, [
    name,
    JSON.stringify(fingerprints),
  ]);
}

export async function removeMcpServer(name: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM mort_mcp_servers WHERE name = $1`, [name]);
  return (rowCount ?? 0) > 0;
}

/**
 * The effective policy for one tool of one server: the server's default tier
 * unless an admin named this tool specifically.
 *
 * Note the direction of the default. A tool nobody has ruled on is
 * `write:world` — confirm-first and admin-only — because the alternative is a
 * server deciding its own blast radius, and a server is exactly the thing we
 * don't trust.
 */
export function effectiveToolPolicy(
  server: McpServerRow,
  tool: string,
): { tier: ToolTier; enabled: boolean } {
  const override = server.toolOverrides[tool];
  return {
    tier: override?.tier ?? server.defaultTier,
    enabled: override?.enabled !== false,
  };
}
