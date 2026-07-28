import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ chatWrites: null as string | null, mode: "live" as string, threshold: 0.6 }));

// resolveKbWriteRoute reads runtime settings; the tiers half of the module is
// pure. Faking the two settings readers keeps both testable without a database.
vi.mock("../memory", () => ({
  getSetting: async (key: string) => (key === "chat_writes" ? state.chatWrites : null),
}));
vi.mock("../memory/config", () => ({
  getEffectiveMode: async () => state.mode,
  getEffectiveThreshold: async () => state.threshold,
}));

const { allowedTiers, isToolAllowed, resolveKbWriteRoute, toolTier, TOOL_TIERS } = await import("./policy");

const admin = { role: "admin" as const };
const member = { role: "member" as const };

beforeEach(() => {
  state.chatWrites = null;
  state.mode = "live";
  state.threshold = 0.6;
});

describe("tool policy tiers", () => {
  it("lets chat read and teach", () => {
    expect(isToolAllowed("kb_search", "chat")).toBe(true);
    expect(isToolAllowed("save_fact", "chat")).toBe(true);
    expect(isToolAllowed("retire_fact", "chat")).toBe(true);
    expect(isToolAllowed("log_event", "chat")).toBe(true);
  });

  it("lets chat change the wiki (P3), gated per-call by resolveKbWriteRoute", () => {
    for (const tool of ["propose_doc_edit", "create_doc", "attach_source", "brain_dump", "apply_doc_edit"]) {
      expect(toolTier(tool)).toBe("write:kb");
      expect(isToolAllowed(tool, "chat")).toBe(true);
    }
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

  it("keeps the chat write:kb tools off the ingest channel too", () => {
    // Ingest writes the KB through the authoring pipeline, which carries its
    // own gates. A document that talks its way into calling create_doc would
    // bypass them, so the tier simply isn't on that channel.
    expect(allowedTiers("ingest")).not.toContain("write:kb");
    for (const tool of ["propose_doc_edit", "create_doc", "brain_dump"]) {
      expect(isToolAllowed(tool, "ingest")).toBe(false);
    }
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

describe("resolveKbWriteRoute", () => {
  it("lets a confident admin apply in live mode", async () => {
    expect((await resolveKbWriteRoute(admin, { confidence: 0.9 })).route).toBe("apply");
  });

  it("sends a member's change to the review queue, never to Outline", async () => {
    const decision = await resolveKbWriteRoute(member, { confidence: 1 });
    expect(decision.route).toBe("review");
    expect(decision.reason).toMatch(/review queue/i);
  });

  it("blankets everything into review in shadow mode — admins included", async () => {
    state.mode = "shadow";
    expect((await resolveKbWriteRoute(admin, { confidence: 1 })).route).toBe("review");
  });

  it("treats 'off' the same as shadow for chat writes rather than applying", async () => {
    state.mode = "off";
    expect((await resolveKbWriteRoute(admin, { confidence: 1 })).route).toBe("review");
  });

  it("reviews a target the model invented, even for a confident admin in live mode", async () => {
    const decision = await resolveKbWriteRoute(admin, { confidence: 1, inventedTarget: true });
    expect(decision.route).toBe("review");
    expect(decision.reason).toMatch(/guessed/i);
  });

  it("reviews anything under the confidence threshold", async () => {
    expect((await resolveKbWriteRoute(admin, { confidence: 0.59 })).route).toBe("review");
    expect((await resolveKbWriteRoute(admin, { confidence: 0.6 })).route).toBe("apply");
  });

  it("applies when no confidence is offered at all (attach has none to give)", async () => {
    expect((await resolveKbWriteRoute(admin, {})).route).toBe("apply");
  });

  it("blocks everyone when chat writes are switched off", async () => {
    state.chatWrites = "off";
    expect((await resolveKbWriteRoute(admin, { confidence: 1 })).route).toBe("blocked");
    expect((await resolveKbWriteRoute(member, { confidence: 1 })).route).toBe("blocked");
  });

  it("puts the member rule ahead of the mode rule, so the explanation stays true when the mode changes", async () => {
    state.mode = "shadow";
    expect((await resolveKbWriteRoute(member, { confidence: 1 })).reason).toMatch(/crew member/i);
  });
});
