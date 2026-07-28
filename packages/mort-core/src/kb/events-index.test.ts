import { describe, expect, it } from "vitest";
import { chatEventRowHash, chatEventSourceId } from "./events-index";

describe("chat-taught events", () => {
  it("namespaces the source by conversation", () => {
    expect(chatEventSourceId("2f8c1a9e-0000-4000-8000-000000000001")).toBe(
      "chat:2f8c1a9e-0000-4000-8000-000000000001",
    );
  });

  it("hashes the same statement to the same row", () => {
    // Said twice in a conversation, phrased slightly differently — one row,
    // because the existing reconcile keys on the hash.
    const a = chatEventRowHash({ occurredOn: "2026-07-27", actionText: "Ran SDI under the floor" });
    const b = chatEventRowHash({ occurredOn: "2026-07-27", actionText: "  ran   SDI under  the floor  " });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates different days and different actions", () => {
    const base = { occurredOn: "2026-07-27", actionText: "Raised the LED wall to 6m" };
    expect(chatEventRowHash({ ...base, occurredOn: "2026-07-28" })).not.toBe(chatEventRowHash(base));
    expect(chatEventRowHash({ ...base, actionText: "Raised the LED wall to 2.5m" })).not.toBe(chatEventRowHash(base));
    expect(chatEventRowHash({ occurredOn: null, actionText: base.actionText })).not.toBe(chatEventRowHash(base));
  });
});
