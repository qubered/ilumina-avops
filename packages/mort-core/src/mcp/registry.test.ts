import { describe, expect, it, vi } from "vitest";

// The registry is thin over Postgres; effectiveToolPolicy is the part with a
// decision in it. Stubbing the pool keeps the pure half testable without a DB.
vi.mock("../memory/db", () => ({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }));

const { effectiveToolPolicy, isMcpTier, MCP_TIERS } = await import("./registry");

const server = {
  name: "venue-pdu",
  transport: "streamable-http" as const,
  config: { url: "https://pdu.local/mcp" },
  enabled: true,
  defaultTier: "write:world" as const,
  toolOverrides: {},
  fingerprints: {},
  description: null,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

describe("effectiveToolPolicy", () => {
  it("treats a tool nobody has ruled on as write:world", () => {
    // The direction of this default is the whole safety story: a server does
    // not get to declare its own blast radius.
    expect(effectiveToolPolicy(server, "power_cycle")).toEqual({ tier: "write:world", enabled: true });
  });

  it("honours an admin's downgrade of one named tool without touching the rest", () => {
    const withOverride = { ...server, toolOverrides: { rack_temperature: { tier: "read" as const } } };
    expect(effectiveToolPolicy(withOverride, "rack_temperature")).toEqual({ tier: "read", enabled: true });
    expect(effectiveToolPolicy(withOverride, "power_cycle")).toEqual({ tier: "write:world", enabled: true });
  });

  it("lets a single tool be taken off the belt while the server stays up", () => {
    const withOverride = { ...server, toolOverrides: { power_cycle: { enabled: false } } };
    expect(effectiveToolPolicy(withOverride, "power_cycle").enabled).toBe(false);
    // enabled: false alone must not quietly change the tier as well.
    expect(effectiveToolPolicy(withOverride, "power_cycle").tier).toBe("write:world");
  });

  it("applies a server-wide default tier when an admin set one", () => {
    const readOnlyServer = { ...server, defaultTier: "read" as const };
    expect(effectiveToolPolicy(readOnlyServer, "anything").tier).toBe("read");
  });
});

describe("MCP tiers", () => {
  it("offers only the two tiers an external tool can meaningfully be on", () => {
    // Not write:kb and not write:memory: an outside server does not write the
    // wiki or Mort's memory, and offering the choice only invites mislabelling.
    expect(MCP_TIERS).toEqual(["read", "write:world"]);
    expect(isMcpTier("read")).toBe(true);
    expect(isMcpTier("write:world")).toBe(true);
    expect(isMcpTier("write:kb")).toBe(false);
    expect(isMcpTier("admin")).toBe(false);
  });
});
