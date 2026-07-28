import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { detectToolDrift, fingerprintTools, type Tool, type ToolSet } from "ai";
import { isStdio, resolveRefs, type HttpConfig, type StdioConfig } from "./config";
import { beltName } from "./naming";
import {
  effectiveToolPolicy,
  listEnabledMcpServers,
  recordMcpFingerprints,
  type McpServerRow,
} from "./registry";
import type { ToolTier } from "../tools/policy";

/**
 * The MCP connection manager (MORT_V2_PLAN I.5).
 *
 * One process-wide map of server name → live client. Connections are
 * reconciled rather than commanded: `syncMcpConnections()` reads the registry,
 * connects what should be up, closes what shouldn't, and is safe to call as
 * often as you like. Boot calls it once; every chat turn calls it again. That
 * is what makes "disable a server in the admin UI and its tools leave the belt"
 * work without a restart, and it is why there are no timers in this file — a
 * failed server is retried on the next turn that happens to be due, not by a
 * background loop that outlives the request that started it.
 *
 * Nothing here decides who may call what. Tiers, roles and confirmation live in
 * tools/policy.ts and mcp/belt.ts; this module only knows how to reach a server
 * and what it offers.
 */

/** 5s, 15s, 45s, … capped at 5 minutes. A dead PDU shouldn't cost every turn. */
const BACKOFF_MS = [5_000, 15_000, 45_000, 135_000, 300_000];

export type McpServerStatus = "connected" | "connecting" | "error";

export type McpToolInfo = {
  /** What the model sees: `mcp__<server>__<tool>`. */
  name: string;
  server: string;
  /** The tool's own name on the server — what callTool takes. */
  tool: string;
  description: string;
  tier: ToolTier;
  enabled: boolean;
  /** The definition changed since an admin last looked at it. */
  drifted: boolean;
};

type ServerState = {
  row: McpServerRow;
  client: MCPClient | null;
  /** AI SDK tools keyed by the SERVER's own tool name. */
  tools: ToolSet;
  status: McpServerStatus;
  lastError: string | null;
  connectedAt: string | null;
  failures: number;
  nextAttemptAt: number;
  /** Tools whose definition differs from the admin-reviewed baseline. */
  drifted: string[];
  /** New tools appearing on a server an admin has already reviewed. */
  appeared: string[];
};

const servers = new Map<string, ServerState>();

/** One reconcile at a time — chat turns arrive concurrently. */
let inFlight: Promise<void> | null = null;

export function syncMcpConnections(): Promise<void> {
  if (!inFlight) {
    inFlight = reconcile().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function reconcile(): Promise<void> {
  let enabled: McpServerRow[];
  try {
    enabled = await listEnabledMcpServers();
  } catch (err) {
    // No registry table, no database: MCP is an optional limb, so a chat turn
    // must still answer questions without it.
    console.error("[mcp] could not read the server registry:", err);
    return;
  }

  const wanted = new Set(enabled.map((s) => s.name));
  for (const [name, state] of servers) {
    if (!wanted.has(name)) {
      await disconnect(name, state);
    }
  }

  const now = Date.now();
  await Promise.all(
    enabled.map(async (row) => {
      const state = servers.get(row.name);
      // A row edited since we connected means the transport or config changed
      // under us — drop the old client rather than keep talking to the old
      // endpoint with the new config on screen.
      if (state && state.row.updatedAt !== row.updatedAt) {
        await disconnect(row.name, state);
      }
      const current = servers.get(row.name);
      if (current?.status === "connected") {
        current.row = row;
        return;
      }
      if (current && now < current.nextAttemptAt) return;
      await connect(row, current?.failures ?? 0);
    }),
  );
}

async function connect(row: McpServerRow, priorFailures: number): Promise<void> {
  const state: ServerState = {
    row,
    client: null,
    tools: {},
    status: "connecting",
    lastError: null,
    connectedAt: null,
    failures: priorFailures,
    nextAttemptAt: 0,
    drifted: [],
    appeared: [],
  };
  servers.set(row.name, state);

  try {
    const client = await createMCPClient({
      transport: buildTransport(row),
      clientName: "mort",
      // An MCP server dying mid-turn must not take the answer with it. Mark the
      // connection failed and let the next reconcile bring it back.
      onUncaughtError: (err) => {
        const held = servers.get(row.name);
        if (!held || held.client !== client) return;
        console.error(`[mcp:${row.name}] transport error:`, err);
        held.status = "error";
        held.lastError = message(err);
        held.tools = {};
      },
    });

    const tools = await client.tools();
    state.client = client;
    state.tools = tools;
    state.status = "connected";
    state.connectedAt = new Date().toISOString();
    state.failures = 0;
    await checkDrift(state, tools);
    console.log(`[mcp:${row.name}] connected — ${Object.keys(tools).length} tool(s)`);
  } catch (err) {
    state.status = "error";
    state.lastError = message(err);
    state.failures = priorFailures + 1;
    state.nextAttemptAt = Date.now() + BACKOFF_MS[Math.min(state.failures - 1, BACKOFF_MS.length - 1)];
    console.error(`[mcp:${row.name}] connect failed (attempt ${state.failures}):`, state.lastError);
  }
}

/**
 * Tool-definition drift ("rug pull"): a server that behaved when an admin
 * approved it can later rewrite a tool's description or schema, and a
 * description is prompt text the model reads. Compare each connect against the
 * digests an admin last acknowledged; a changed tool stays callable — every
 * MCP call is confirm-gated anyway — but says so on the card and in the panel.
 *
 * A server with no baseline at all is a first connect: record it silently,
 * because there is nothing to have drifted from yet.
 */
async function checkDrift(state: ServerState, tools: ToolSet): Promise<void> {
  try {
    const current = await fingerprintTools(tools);
    const baseline = state.row.fingerprints;
    if (Object.keys(baseline).length === 0) {
      await recordMcpFingerprints(state.row.name, current);
      state.row = { ...state.row, fingerprints: current };
      return;
    }
    const { added, changed } = detectToolDrift(current, baseline);
    state.drifted = changed;
    state.appeared = added;
    if (changed.length || added.length) {
      console.warn(
        `[mcp:${state.row.name}] tool definitions drifted since review — changed: ${changed.join(", ") || "none"}; new: ${added.join(", ") || "none"}`,
      );
    }
  } catch (err) {
    console.error(`[mcp:${state.row.name}] fingerprinting failed:`, err);
  }
}

function buildTransport(row: McpServerRow) {
  if (isStdio(row.transport)) {
    const config = row.config as StdioConfig;
    return new StdioMCPTransport({
      command: config.command,
      args: config.args,
      env: resolveRefs(config.env),
      cwd: config.cwd,
    });
  }
  const config = row.config as HttpConfig;
  return {
    // The registry's `streamable-http` is the spec's name for what the AI SDK
    // client calls `http`; `sse` is the older transport, kept because plenty of
    // shipped servers still only speak it.
    type: row.transport === "sse" ? ("sse" as const) : ("http" as const),
    url: config.url,
    headers: resolveRefs(config.headers),
  };
}

async function disconnect(name: string, state: ServerState): Promise<void> {
  servers.delete(name);
  try {
    await state.client?.close();
  } catch (err) {
    // Closing a transport that already died is not news.
    console.warn(`[mcp:${name}] close failed:`, message(err));
  }
}

/** Drop every connection — used when the process is shutting down. */
export async function closeMcpConnections(): Promise<void> {
  await Promise.all([...servers.entries()].map(([name, state]) => disconnect(name, state)));
}

/**
 * Force a server's connection to be rebuilt on the next sync. Called after an
 * admin toggles or reconfigures one, so the change lands on the current turn
 * rather than after a backoff.
 */
export async function refreshMcpServer(name: string): Promise<void> {
  // Let any reconcile already running finish first. Without this the sync below
  // could return that in-flight promise — one that read the registry BEFORE the
  // admin's change — and the panel would render the state they just left.
  await inFlight?.catch(() => {});
  const state = servers.get(name);
  if (state) await disconnect(name, state);
  await syncMcpConnections();
}

// --- reading the connected belt ---------------------------------------------

export type McpServerStatusRow = {
  name: string;
  status: McpServerStatus;
  lastError: string | null;
  connectedAt: string | null;
  tools: McpToolInfo[];
  /** Tools whose definition changed since an admin reviewed the server. */
  drifted: string[];
  appeared: string[];
};

/** Live status of every connected/attempted server, for the admin panel. */
export function mcpStatus(): McpServerStatusRow[] {
  return [...servers.values()].map((state) => ({
    name: state.row.name,
    status: state.status,
    lastError: state.lastError,
    connectedAt: state.connectedAt,
    tools: toolsOf(state),
    drifted: state.drifted,
    appeared: state.appeared,
  }));
}

/** Every discovered tool across every connected server, policy resolved. */
export function mcpTools(): McpToolInfo[] {
  return [...servers.values()].flatMap(toolsOf);
}

function toolsOf(state: ServerState): McpToolInfo[] {
  return Object.entries(state.tools).map(([tool, definition]) => {
    const policy = effectiveToolPolicy(state.row, tool);
    return {
      name: beltName(state.row.name, tool),
      server: state.row.name,
      tool,
      description: describe(definition),
      tier: policy.tier,
      enabled: policy.enabled,
      drifted: state.drifted.includes(tool) || state.appeared.includes(tool),
    };
  });
}

function describe(definition: Tool): string {
  return typeof definition.description === "string" ? definition.description : "";
}

/**
 * The raw AI SDK tool definition for a belt entry — its schema and description,
 * as the model needs to see them. The `execute` on it is deliberately NOT used
 * by the belt: calls go through `callMcpTool` so that every one of them passes
 * the same policy check and lands in the journal.
 */
export function mcpToolDefinition(server: string, tool: string): Tool | null {
  return servers.get(server)?.tools[tool] ?? null;
}

export type McpCallResult = {
  ok: boolean;
  /** The server's answer, flattened to text — what the model reads back. */
  text: string;
  /** Structured content when the server provided it. */
  structured?: unknown;
};

/**
 * Call a tool on a connected server. Failures come back as `ok: false` rather
 * than as throws: an unreachable console is something Mort tells the crew
 * about, not something that kills the stream (the v1 degradation pattern).
 */
export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const state = servers.get(server);
  if (!state || state.status !== "connected" || !state.client) {
    return { ok: false, text: `The '${server}' server isn't connected right now${state?.lastError ? ` (${state.lastError})` : ""}.` };
  }
  if (!state.tools[tool]) {
    return { ok: false, text: `'${server}' doesn't offer a tool called '${tool}'.` };
  }
  try {
    const result = await state.client.callTool({ name: tool, arguments: args });
    return {
      ok: !result.isError,
      text: flatten(result.content),
      ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
    };
  } catch (err) {
    // A call that threw says nothing certain about the connection, but it does
    // say the next reconcile should look: an error state is cheap to recover.
    state.status = "error";
    state.lastError = message(err);
    return { ok: false, text: `Calling ${server}.${tool} failed: ${message(err)}` };
  }
}

function flatten(content: unknown): string {
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  const parts = content.map((part) => {
    const p = part as { type?: string; text?: string };
    if (p?.type === "text" && typeof p.text === "string") return p.text;
    // Images, embedded resources and anything a future spec adds: name the
    // shape rather than dumping bytes into the conversation.
    return `[${p?.type ?? "content"}]`;
  });
  return parts.join("\n").trim();
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Test seam: forget every connection without touching the registry. */
export function __resetMcpManager(): void {
  servers.clear();
}
