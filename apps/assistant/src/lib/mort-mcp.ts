import { fingerprintTools, type ToolSet } from "ai";
import {
  callMcpTool,
  getMcpServer,
  mcpToolDefinition,
  listMcpServers,
  mcpStatus,
  recordMcpFingerprints,
  redactConfig,
  refreshMcpServer,
  removeMcpServer,
  setMcpServerEnabled,
  setMcpToolOverride,
  syncMcpConnections,
  upsertMcpServer,
  type McpTier,
  type McpTransportKind,
} from "@mort/core/mcp";
import { appendJournal, setSetting } from "@mort/core/memory";
import { mcpEnabled } from "@mort/core/tools/policy";

/**
 * The admin UI's view of the MCP harness (MORT_V2_PLAN I.5).
 *
 * Two sources joined into one shape: the registry rows (what an admin
 * configured) and the manager's live state (whether it's actually reachable
 * and what it turned out to offer). Keeping them apart in storage and together
 * on screen is the point — "enabled" and "connected" are different facts and
 * an admin chasing a dead console needs to see which one is false.
 *
 * Every mutation here is journaled. Arming a server is a decision with real
 * consequences and it should be as reconstructable as approving a fact.
 */

export type McpToolView = {
  tool: string;
  description: string;
  tier: McpTier;
  enabled: boolean;
  drifted: boolean;
};

export type McpServerView = {
  name: string;
  transport: McpTransportKind;
  /** Credentials masked; env refs left as refs since they name a variable. */
  config: Record<string, unknown>;
  enabled: boolean;
  defaultTier: McpTier;
  description: string | null;
  status: "connected" | "connecting" | "error" | "disabled";
  lastError: string | null;
  connectedAt: string | null;
  tools: McpToolView[];
  /** Tool definitions that changed since this server was last reviewed. */
  drifted: string[];
  updatedAt: string;
};

export type McpOverview = {
  /** The master switch — freezes every connected tool at once. */
  enabled: boolean;
  servers: McpServerView[];
};

export async function getMcpOverview(): Promise<McpOverview> {
  try {
    // Reconcile before reading, so a row toggled on another instance (or this
    // page's own last action) is reflected rather than reported from a stale
    // connection map.
    await syncMcpConnections();
  } catch (err) {
    console.error("[mort-mcp] sync failed:", err);
  }

  let rows: Awaited<ReturnType<typeof listMcpServers>> = [];
  try {
    rows = await listMcpServers();
  } catch (err) {
    console.error("[mort-mcp] listMcpServers failed:", err);
    return { enabled: true, servers: [] };
  }

  const live = new Map(mcpStatus().map((s) => [s.name, s]));

  return {
    enabled: await mcpEnabled().catch(() => true),
    servers: rows.map((row) => {
      const state = live.get(row.name);
      return {
        name: row.name,
        transport: row.transport,
        config: redactConfig(row.config),
        enabled: row.enabled,
        defaultTier: row.defaultTier,
        description: row.description,
        // A disabled server has no connection to report on, and saying "error"
        // because we never tried would send an admin hunting a fault that is
        // just a switch being off.
        status: row.enabled ? (state?.status ?? "connecting") : "disabled",
        lastError: state?.lastError ?? null,
        connectedAt: state?.connectedAt ?? null,
        tools: (state?.tools ?? []).map((t) => ({
          tool: t.tool,
          description: t.description,
          tier: t.tier as McpTier,
          enabled: t.enabled,
          drifted: t.drifted,
        })),
        drifted: [...(state?.drifted ?? []), ...(state?.appeared ?? [])],
        updatedAt: row.updatedAt,
      };
    }),
  };
}

type Result = { ok: boolean; status: number; json: unknown };

const failed = (err: unknown, status = 400): Result => ({
  ok: false,
  status,
  json: { error: err instanceof Error ? err.message : "failed" },
});

export async function registerMcpServer(
  input: { name: string; transport: string; config: unknown; description?: string | null },
  by: string,
): Promise<Result> {
  try {
    const row = await upsertMcpServer(input);
    await appendJournal({
      action: "mcp_registered",
      rationale: `${row.name} (${row.transport}) registered — disabled until enabled`,
      channel: "admin",
      actor: by,
      details: { server: row.name, transport: row.transport },
    });
    // Re-registering may have changed the endpoint under a live connection.
    await refreshMcpServer(row.name).catch(() => {});
    return { ok: true, status: 201, json: { name: row.name, enabled: row.enabled } };
  } catch (err) {
    return failed(err);
  }
}

export async function toggleMcpServer(name: string, enabled: boolean, by: string): Promise<Result> {
  try {
    const row = await setMcpServerEnabled(name, enabled);
    if (!row) return { ok: false, status: 404, json: { error: `No MCP server called '${name}'.` } };
    await appendJournal({
      action: enabled ? "mcp_enabled" : "mcp_disabled",
      rationale: `${name} ${enabled ? "enabled" : "disabled"} from the admin panel`,
      channel: "admin",
      actor: by,
      details: { server: name, enabled },
    });
    // Connect or drop straight away rather than at the next turn: an admin who
    // just disabled a console expects it to be unreachable now.
    await refreshMcpServer(name).catch((err) => console.error(`[mort-mcp] refresh ${name} failed:`, err));
    return { ok: true, status: 200, json: { name, enabled: row.enabled } };
  } catch (err) {
    return failed(err, 500);
  }
}

export async function overrideMcpTool(
  name: string,
  tool: string,
  override: { tier?: McpTier; enabled?: boolean },
  by: string,
): Promise<Result> {
  try {
    const row = await setMcpToolOverride(name, tool, override);
    if (!row) return { ok: false, status: 404, json: { error: `No MCP server called '${name}'.` } };
    await appendJournal({
      // Downgrading a tool to `read` is the one act that lets Mort call
      // something without asking first, so it is journaled as its own decision
      // rather than folded into a generic "settings changed".
      action: "mcp_tool_override",
      rationale: `${name}.${tool} → ${JSON.stringify(override)}`,
      channel: "admin",
      actor: by,
      details: { server: name, tool, ...override },
    });
    return { ok: true, status: 200, json: { name, tool, ...override } };
  } catch (err) {
    return failed(err, 500);
  }
}

export async function deleteMcpServer(name: string, by: string): Promise<Result> {
  try {
    const removed = await removeMcpServer(name);
    if (!removed) return { ok: false, status: 404, json: { error: `No MCP server called '${name}'.` } };
    await appendJournal({
      action: "mcp_removed",
      rationale: `${name} removed from the registry`,
      channel: "admin",
      actor: by,
      details: { server: name },
    });
    await refreshMcpServer(name).catch(() => {});
    return { ok: true, status: 200, json: { name, removed: true } };
  } catch (err) {
    return failed(err, 500);
  }
}

/**
 * Call a tool straight from the admin panel — the "does this thing actually
 * work" button. Journaled like any other call, and deliberately not exempt
 * from anything: it goes through the same manager, against the same connected
 * server, with the admin's name on it. It skips only the confirmation card,
 * because pressing this button IS the confirmation.
 */
export async function testMcpTool(
  name: string,
  tool: string,
  args: Record<string, unknown>,
  by: string,
): Promise<Result> {
  try {
    await syncMcpConnections();
    const started = Date.now();
    const result = await callMcpTool(name, tool, args);
    const latencyMs = Date.now() - started;
    await appendJournal({
      action: "mcp_call",
      rationale: `${name}.${tool} ${result.ok ? "ok" : "failed"} (admin test call, ${latencyMs}ms)`,
      channel: "admin",
      actor: by,
      details: { server: name, tool, outcome: result.ok ? "ok" : "error", latencyMs, test: true },
    });
    return { ok: true, status: 200, json: { ok: result.ok, output: result.text, latencyMs } };
  } catch (err) {
    return failed(err, 500);
  }
}

/**
 * Accept a server's current tool definitions as the reviewed baseline, which
 * is what clears a drift warning. Deliberately its own action: the fix for
 * "this tool's description changed" is a human reading the new one, and a
 * button that says "Reviewed" records that someone did.
 */
export async function acknowledgeMcpDrift(name: string, by: string): Promise<Result> {
  try {
    const row = await getMcpServer(name);
    if (!row) return { ok: false, status: 404, json: { error: `No MCP server called '${name}'.` } };
    const state = mcpStatus().find((s) => s.name === name);
    if (!state || state.status !== "connected") {
      return { ok: false, status: 409, json: { error: "That server isn't connected, so there's nothing to review." } };
    }
    // Re-fingerprint from the live connection rather than trusting whatever the
    // panel last rendered — the definitions being accepted have to be the ones
    // actually on the wire right now.
    const tools = Object.fromEntries(
      state.tools.map((t) => [t.tool, mcpToolDefinition(name, t.tool)]).filter(([, d]) => d != null),
    );
    await recordMcpFingerprints(name, await fingerprintTools(tools as ToolSet));
    await appendJournal({
      action: "mcp_drift_reviewed",
      rationale: `${name} tool definitions reviewed and accepted`,
      channel: "admin",
      actor: by,
      details: { server: name, tools: state.tools.map((t) => t.tool) },
    });
    await refreshMcpServer(name).catch(() => {});
    return { ok: true, status: 200, json: { name, reviewed: true } };
  } catch (err) {
    return failed(err, 500);
  }
}

export async function setMcpMasterSwitch(enabled: boolean, by: string): Promise<Result> {
  try {
    await setSetting("mcp", enabled ? "on" : "off");
    await appendJournal({
      action: enabled ? "mcp_unfrozen" : "mcp_frozen",
      rationale: `connected tools ${enabled ? "re-enabled" : "frozen"} from the admin panel`,
      channel: "admin",
      actor: by,
    });
    return { ok: true, status: 200, json: { enabled } };
  } catch (err) {
    return failed(err, 500);
  }
}
