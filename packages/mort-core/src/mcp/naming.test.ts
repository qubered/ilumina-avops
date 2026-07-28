import { describe, expect, it } from "vitest";
import { beltName, isMcpTool, isValidServerName, parseBeltName, sanitizeToolName, serverNameError } from "./naming";

describe("MCP tool namespacing", () => {
  it("prefixes every plugged-in tool so it can't shadow a native one", () => {
    expect(beltName("venue-pdu", "power_cycle")).toBe("mcp__venue-pdu__power_cycle");
    // The attack this closes: a server offering a tool called `save_fact`.
    expect(beltName("evil", "save_fact")).toBe("mcp__evil__save_fact");
    expect(isMcpTool(beltName("evil", "save_fact"))).toBe(true);
    expect(isMcpTool("save_fact")).toBe(false);
  });

  it("round-trips a belt name back to its server and tool", () => {
    expect(parseBeltName("mcp__venue-pdu__power_cycle")).toEqual({ server: "venue-pdu", tool: "power_cycle" });
  });

  it("keeps the whole tail as the tool name when the tool has a separator in it", () => {
    // Splitting on the FIRST separator matters: the server name never contains
    // one, but a sanitised tool name can.
    expect(parseBeltName("mcp__pdu__a__b")).toEqual({ server: "pdu", tool: "a__b" });
  });

  it("rejects names that aren't ours", () => {
    expect(parseBeltName("kb_search")).toBeNull();
    expect(parseBeltName("mcp__")).toBeNull();
    expect(parseBeltName("mcp__pdu")).toBeNull();
  });

  it("sanitises server-supplied tool names to what providers accept", () => {
    expect(sanitizeToolName("power/cycle")).toBe("power_cycle");
    expect(sanitizeToolName("get status!")).toBe("get_status_");
    expect(sanitizeToolName("x".repeat(80))).toHaveLength(40);
  });

  it("holds server names to a shape that's safe inside a tool name", () => {
    expect(isValidServerName("venue-pdu")).toBe(true);
    expect(isValidServerName("e2")).toBe(true);
    // Underscores are the separator, so a server may not contain one.
    expect(isValidServerName("venue_pdu")).toBe(false);
    expect(isValidServerName("Venue")).toBe(false);
    expect(isValidServerName("-lead")).toBe(false);
    expect(isValidServerName("")).toBe(false);
    expect(isValidServerName("a".repeat(25))).toBe(false);
    expect(serverNameError("venue-pdu")).toBeNull();
    expect(serverNameError("Venue_PDU")).toMatch(/lowercase/);
  });
});
