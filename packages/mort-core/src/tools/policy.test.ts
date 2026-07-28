import { describe, expect, it } from "vitest";
import { allowedTiers, isToolAllowed, toolTier, TOOL_TIERS } from "./policy";

describe("tool policy tiers", () => {
  it("lets chat read and teach", () => {
    expect(isToolAllowed("kb_search", "chat")).toBe(true);
    expect(isToolAllowed("save_fact", "chat")).toBe(true);
    expect(isToolAllowed("retire_fact", "chat")).toBe(true);
    expect(isToolAllowed("log_event", "chat")).toBe(true);
  });

  it("keeps ingest away from Mort's memory", () => {
    // The injection posture (Part IV): a OneDrive document is untrusted input,
    // and the ingest channel simply has no write:memory tier to reach for.
    expect(allowedTiers("ingest")).not.toContain("write:memory");
    for (const tool of ["save_fact", "retire_fact", "log_event"]) {
      expect(isToolAllowed(tool, "ingest")).toBe(false);
    }
    expect(isToolAllowed("kb_search", "ingest")).toBe(true);
  });

  it("denies tools nobody declared a tier for", () => {
    expect(toolTier("rm_rf")).toBeNull();
    expect(isToolAllowed("rm_rf", "chat")).toBe(false);
    // confirm_pending is deliberately untiered: it inherits the tier of the
    // card it points at, re-checked at confirm time.
    expect(TOOL_TIERS.confirm_pending).toBeUndefined();
  });

  it("keeps every write tool out of the dream channel", () => {
    for (const [tool, tier] of Object.entries(TOOL_TIERS)) {
      if (tier === "read") continue;
      expect(isToolAllowed(tool, "dream")).toBe(false);
    }
  });
});
