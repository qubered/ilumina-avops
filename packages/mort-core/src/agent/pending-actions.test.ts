import { describe, expect, it } from "vitest";
import {
  actorLabel,
  logEventPayload,
  PAYLOAD_SCHEMAS,
  previewFor,
  retireFactPayload,
  saveFactPayload,
} from "./pending-actions";

describe("confirmation previews", () => {
  it("states the whole fact, including what it replaces", () => {
    const preview = previewFor(
      "save_fact",
      { factKey: "led-wall-height", value: "6m", scope: "Main Stage", effectiveFrom: "2026-07-28" },
      "2.5m",
    );
    expect(preview).toContain("led-wall-height");
    expect(preview).toContain("6m");
    expect(preview).toContain("Main Stage");
    expect(preview).toContain("2026-07-28");
    // The part a user would otherwise only discover afterwards.
    expect(preview).toContain("replaces");
    expect(preview).toContain("2.5m");
  });

  it("omits the replacement clause when nothing is being replaced", () => {
    expect(previewFor("save_fact", { factKey: "spare-dsp", value: "in use" })).not.toContain("replaces");
  });

  it("names the fact being retired, not just its id", () => {
    const preview = previewFor("retire_fact", { factId: 12, factKey: "led-wall-height", value: "6m" });
    expect(preview).toContain("led-wall-height");
    expect(preview).toContain("6m");
  });

  it("falls back to the id when the fact was not snapshotted", () => {
    expect(previewFor("retire_fact", { factId: 12 })).toContain("#12");
  });

  it("dates an event preview", () => {
    const preview = previewFor("log_event", {
      actionText: "Ran SDI under the floor",
      occurredOn: "2026-07-27",
      event: "Bump-in",
    });
    expect(preview).toContain("Ran SDI under the floor");
    expect(preview).toContain("2026-07-27");
    expect(preview).toContain("Bump-in");
  });
});

describe("payload schemas", () => {
  it("covers every tool that can raise a card", () => {
    expect(Object.keys(PAYLOAD_SCHEMAS).sort()).toEqual(["log_event", "retire_fact", "save_fact"]);
  });

  it("rejects dates that aren't dates", () => {
    expect(saveFactPayload.safeParse({ factKey: "k", value: "v", effectiveFrom: "yesterday" }).success).toBe(false);
    expect(saveFactPayload.safeParse({ factKey: "k", value: "v", effectiveFrom: "2026-07-28" }).success).toBe(true);
    expect(logEventPayload.safeParse({ actionText: "did a thing", occurredOn: "28/07/26" }).success).toBe(false);
  });

  it("requires something to retire", () => {
    expect(retireFactPayload.safeParse({}).success).toBe(false);
    expect(retireFactPayload.safeParse({ factId: 3 }).success).toBe(true);
  });

  it("rejects an empty fact", () => {
    expect(saveFactPayload.safeParse({ factKey: "", value: "v" }).success).toBe(false);
    expect(saveFactPayload.safeParse({ factKey: "k", value: "" }).success).toBe(false);
  });
});

describe("attribution", () => {
  it("prefers the email, the way v1's approvedBy read", () => {
    expect(actorLabel({ id: "u1", email: "jayden@qubered.com", name: "Jayden", role: "admin" })).toBe(
      "jayden@qubered.com",
    );
    expect(actorLabel({ id: "u1", name: "Jayden", role: "member" })).toBe("Jayden");
    // Never blank: a fact with no name on it has no business outranking the KB.
    expect(actorLabel({ id: "u1", role: "member" })).toBe("u1");
  });
});
