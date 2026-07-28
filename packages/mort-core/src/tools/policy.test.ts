import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActingUser } from "./policy";

/**
 * The routing table for chat KB writes. These are the rules that decide whether
 * a conversation can change the wiki, so they get tested against fakes rather
 * than a live database — the point is the decision, not the plumbing.
 */

const settings = vi.hoisted(() => ({ chatWrites: null as string | null }));
const config = vi.hoisted(() => ({ mode: "live" as string, threshold: 0.6 }));

vi.mock("../memory", () => ({
  getSetting: async (key: string) => (key === "chat_writes" ? settings.chatWrites : null),
}));
vi.mock("../memory/config", () => ({
  getEffectiveMode: async () => config.mode,
  getEffectiveThreshold: async () => config.threshold,
}));

const { resolveKbWriteRoute } = await import("./policy");

const admin: ActingUser = { id: "u1", label: "jayden@qubered.com", role: "admin" };
const member: ActingUser = { id: "u2", label: "crew@qubered.com", role: "member" };

beforeEach(() => {
  settings.chatWrites = null;
  config.mode = "live";
  config.threshold = 0.6;
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
    config.mode = "shadow";
    expect((await resolveKbWriteRoute(admin, { confidence: 1 })).route).toBe("review");
  });

  it("treats 'off' the same as shadow for chat writes rather than applying", async () => {
    config.mode = "off";
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
    settings.chatWrites = "off";
    expect((await resolveKbWriteRoute(admin, { confidence: 1 })).route).toBe("blocked");
    expect((await resolveKbWriteRoute(member, { confidence: 1 })).route).toBe("blocked");
  });

  it("puts the member rule ahead of the mode rule, so the explanation stays true when the mode changes", async () => {
    config.mode = "shadow";
    expect((await resolveKbWriteRoute(member, { confidence: 1 })).reason).toMatch(/crew member/i);
  });
});
