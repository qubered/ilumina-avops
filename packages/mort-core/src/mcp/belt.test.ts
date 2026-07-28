import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";

/**
 * The acceptance criteria for P5, exercised against a fake server:
 *
 *   "Register a demo MCP server → its tools appear in Mort's belt namespaced,
 *    confirm-gated, journaled; disabling the server removes them."
 *   "A member cannot trigger any MCP tool; an admin gets a confirmation card
 *    per call."
 *
 * Only the edges are faked — the transport, the card store and the journal.
 * The policy decisions under test are the real ones.
 */

const state = vi.hoisted(() => ({
  mcp: null as string | null,
  tools: [] as Array<{ name: string; server: string; tool: string; description: string; tier: string; enabled: boolean; drifted: boolean }>,
  calls: [] as Array<{ server: string; tool: string; args: Record<string, unknown> }>,
  cards: [] as Array<{ tool: string; payload: Record<string, unknown>; preview: string; warnings?: string[] }>,
  journal: [] as Array<{ action: string; details?: Record<string, unknown> }>,
  callResult: { ok: true, text: "22.4 °C" } as { ok: boolean; text: string },
}));

vi.mock("../memory", () => ({
  appendJournal: async (entry: { action: string; details?: Record<string, unknown> }) => {
    state.journal.push(entry);
  },
}));
// The `mcp` master switch is read through memory/settings (P4 split it out of
// memory/index so the spend ledger and the policy could share it).
vi.mock("../memory/settings", () => ({
  getSetting: async (key: string) => (key === "mcp" ? state.mcp : null),
}));
vi.mock("../memory/config", () => ({
  getEffectiveMode: async () => "live",
  getEffectiveThreshold: async () => 0.6,
}));
vi.mock("./manager", () => ({
  syncMcpConnections: async () => {},
  refreshMcpServer: async () => {},
  mcpTools: () => state.tools,
  mcpToolDefinition: (server: string, tool: string) =>
    state.tools.some((t) => t.server === server && t.tool === tool)
      ? { description: "from the server", inputSchema: { jsonSchema: { type: "object" } } }
      : null,
  callMcpTool: async (server: string, tool: string, args: Record<string, unknown>) => {
    state.calls.push({ server, tool, args });
    return state.callResult;
  },
}));
vi.mock("./registry", () => ({
  listMcpServers: async () => [],
  getMcpServer: async () => null,
  setMcpServerEnabled: async () => null,
}));
vi.mock("../agent/cards", () => ({
  raiseCard: async (
    _ctx: unknown,
    tool: string,
    payload: Record<string, unknown>,
    preview: string,
    extra: { warnings?: string[] } = {},
  ) => {
    state.cards.push({ tool, payload, preview, warnings: extra.warnings });
    return { pendingId: "card-1", tool, payload, preview, status: "pending", note: "NOT DONE YET", ...extra };
  },
}));

const { buildMcpTools } = await import("./belt");

const ctx = (role: "admin" | "member") => ({
  conversationId: "c1",
  user: { id: "u1", email: `${role}@ilumina.test`, role },
  seen: new Set<string>(),
});

const TEMPERATURE = {
  name: "mcp__venue-pdu__rack_temperature",
  server: "venue-pdu",
  tool: "rack_temperature",
  description: "Read the rack temperature",
  tier: "read",
  enabled: true,
  drifted: false,
};

const POWER_CYCLE = {
  name: "mcp__venue-pdu__power_cycle",
  server: "venue-pdu",
  tool: "power_cycle",
  description: "Power cycle an outlet",
  tier: "write:world",
  enabled: true,
  drifted: false,
};

/**
 * Invoke a belt entry the way the SDK would. Cast through unknown because an
 * MCP tool's input type is only known at runtime — the same reason the belt
 * itself casts when it assembles them.
 */
const run = (belt: ToolSet, name: string, args: Record<string, unknown> = {}) =>
  (belt[name].execute as unknown as (a: unknown) => Promise<Record<string, unknown>>)(args);

beforeEach(() => {
  state.mcp = null;
  state.tools = [POWER_CYCLE, TEMPERATURE];
  state.calls = [];
  state.cards = [];
  state.journal = [];
  state.callResult = { ok: true, text: "22.4 °C" };
});

describe("the MCP belt", () => {
  it("puts a connected server's tools on an admin's belt, namespaced", async () => {
    const belt = await buildMcpTools(ctx("admin"));
    expect(Object.keys(belt).sort()).toEqual(["mcp__venue-pdu__power_cycle", "mcp__venue-pdu__rack_temperature"]);
  });

  it("frames the server's own description as a claim, not an instruction", async () => {
    const belt = await buildMcpTools(ctx("admin"));
    expect((belt["mcp__venue-pdu__power_cycle"] as { description: string }).description).toMatch(
      /\[venue-pdu, connected equipment\]/,
    );
  });

  it("builds a crew member no MCP belt at all", async () => {
    // Absent rather than refused: a tool that isn't there is one no
    // conversation can talk Mort into reaching for.
    expect(await buildMcpTools(ctx("member"))).toEqual({});
  });

  it("gives an admin a confirmation card per write:world call, and calls nothing", async () => {
    const belt = await buildMcpTools(ctx("admin"));
    const result = await run(belt, "mcp__venue-pdu__power_cycle", { outlet: 3 });

    expect(state.calls).toEqual([]);
    expect(result.status).toBe("pending");
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0].tool).toBe("mcp_call");
    // The card names the server, the tool and the exact arguments — whoever
    // confirms is authorising an action on real equipment.
    expect(state.cards[0].preview).toBe('Run venue-pdu.power_cycle with {"outlet":3}');
    expect(state.cards[0].payload).toMatchObject({ server: "venue-pdu", tool: "power_cycle", args: { outlet: 3 } });
  });

  it("runs a tool an admin downgraded to read, and journals it", async () => {
    const belt = await buildMcpTools(ctx("admin"));
    const result = await run(belt, "mcp__venue-pdu__rack_temperature");

    expect(state.cards).toEqual([]);
    expect(state.calls).toEqual([{ server: "venue-pdu", tool: "rack_temperature", args: {} }]);
    expect(result.result).toBe("22.4 °C");

    const entry = state.journal.find((e) => e.action === "mcp_call");
    expect(entry?.details).toMatchObject({ server: "venue-pdu", tool: "rack_temperature", tier: "read", outcome: "ok" });
    // Args are hashed, never stored: the journal answers "same call as last
    // time?" without accumulating whatever was passed.
    expect(entry?.details?.argsHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(entry?.details)).not.toContain("22.4");
  });

  it("degrades a failed call to a tool result rather than throwing", async () => {
    // The v1 rule: an unreachable console is something Mort tells the crew
    // about, not something that kills the stream.
    state.callResult = { ok: false, text: "connection refused" };
    const belt = await buildMcpTools(ctx("admin"));
    await expect(run(belt, "mcp__venue-pdu__rack_temperature")).resolves.toMatchObject({
      error: "connection refused",
    });
    expect(state.journal.at(-1)?.details).toMatchObject({ outcome: "error" });
  });

  it("blocks and logs every call when the master switch is off", async () => {
    state.mcp = "off";
    const belt = await buildMcpTools(ctx("admin"));
    const result = await run(belt, "mcp__venue-pdu__rack_temperature");

    expect(result.status).toBe("blocked");
    expect(state.calls).toEqual([]);
    // A refusal is the entry worth having most: a run of them is what an
    // injection reaching for the gear looks like from outside.
    expect(state.journal.map((e) => e.action)).toContain("mcp_refused");
  });

  it("leaves a tool an admin took off the belt off it", async () => {
    state.tools = [{ ...POWER_CYCLE, enabled: false }, TEMPERATURE];
    const belt = await buildMcpTools(ctx("admin"));
    expect(Object.keys(belt)).toEqual(["mcp__venue-pdu__rack_temperature"]);
  });

  it("empties the belt when a server is disabled — nothing left to call", async () => {
    state.tools = [];
    expect(await buildMcpTools(ctx("admin"))).toEqual({});
  });

  it("warns on the card when a tool's definition changed since it was reviewed", async () => {
    state.tools = [{ ...POWER_CYCLE, drifted: true }];
    const belt = await buildMcpTools(ctx("admin"));
    await run(belt, "mcp__venue-pdu__power_cycle", {});
    expect(state.cards[0].warnings?.[0]).toMatch(/changed this tool's definition/i);
    expect(state.cards[0].payload.drifted).toBe(true);
  });

  it("won't build an MCP belt on the ingest or dream channels", async () => {
    // Belt and braces over the channel tiers: even an admin-owned turn on the
    // ingest channel gets nothing, because the tier isn't on that channel.
    expect(await buildMcpTools(ctx("admin"), "ingest")).toEqual({});
    expect(await buildMcpTools(ctx("admin"), "dream")).toEqual({});
  });
});
