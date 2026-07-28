import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ chatWrites: null as string | null, mode: "live" as string, threshold: 0.6 }));

// resolveKbWriteRoute reads runtime settings; the tiers half of the module is
// pure. Faking the two settings readers keeps both testable without a database.
vi.mock("../memory/settings", () => ({
  getSetting: async (key: string) => (key === "chat_writes" ? state.chatWrites : null),
}));
vi.mock("../memory/config", () => ({
  getEffectiveMode: async () => state.mode,
  getEffectiveThreshold: async () => state.threshold,
}));

const { allowedTiers, isTierAllowed, resolveKbWriteRoute, tierNeedsConfirmation } = await import("./policy");

const admin = { role: "admin" as const };
const member = { role: "member" as const };

beforeEach(() => {
  state.chatWrites = null;
  state.mode = "live";
  state.threshold = 0.6;
});

describe("channel/role tier policy", () => {
  it("lets chat read, teach and change the wiki, whoever is talking", () => {
    for (const role of ["admin", "member"] as const) {
      expect(isTierAllowed("read", "chat", role)).toBe(true);
      expect(isTierAllowed("write:memory", "chat", role)).toBe(true);
      expect(isTierAllowed("write:kb", "chat", role)).toBe(true);
    }
  });

  it("keeps ingest away from Mort's memory and from the world", () => {
    // The injection posture (Part IV): a OneDrive document is untrusted input,
    // and the ingest channel simply has no write:memory tier to reach for. Not
    // a rule the document could argue with — a tier that isn't there.
    expect(allowedTiers("ingest")).toEqual(["read"]);
    for (const tier of ["write:memory", "write:kb", "write:world", "admin"] as const) {
      expect(isTierAllowed(tier, "ingest", "admin")).toBe(false);
    }
    expect(isTierAllowed("read", "ingest")).toBe(true);
  });

  it("keeps the dream read-only", () => {
    expect(allowedTiers("dream")).toEqual(["read"]);
    for (const tier of ["write:memory", "write:kb", "write:world", "admin"] as const) {
      expect(isTierAllowed(tier, "dream", "admin")).toBe(false);
    }
  });

  it("reserves world and operator tiers for admins, even in chat", () => {
    expect(isTierAllowed("write:world", "chat", "admin")).toBe(true);
    expect(isTierAllowed("write:world", "chat", "member")).toBe(false);
    expect(isTierAllowed("admin", "chat", "admin")).toBe(true);
    expect(isTierAllowed("admin", "chat", "member")).toBe(false);
  });

  it("treats an unrecognised role as a member — less access, never more", () => {
    // Roles arrive from the auth plugin as strings; a typo or a role added
    // later must not accidentally grant the operator tier.
    expect(isTierAllowed("admin", "chat", "superuser" as never)).toBe(false);
    expect(isTierAllowed("read", "chat", "superuser" as never)).toBe(true);
  });

  it("makes only write:world confirm-first as a tier", () => {
    // The others are confirm-first per TOOL (every write tool raises a card),
    // but write:world is the tier that may never fire unattended at all.
    expect(tierNeedsConfirmation("write:world")).toBe(true);
    for (const tier of ["read", "write:memory", "write:kb", "admin"] as const) {
      expect(tierNeedsConfirmation(tier)).toBe(false);
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
