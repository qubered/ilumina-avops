import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }));

const { argsHash } = await import("./tool-journal");

/**
 * The audit trail stores a fingerprint of a call's arguments, not the
 * arguments. "Which tool, by whom, on which channel, and did it run" is the
 * question it answers; keeping a second copy of every fact and page body in an
 * append-only table answers nothing extra and doubles the places content has to
 * be deleted from.
 */
describe("argsHash", () => {
  it("gives the same call the same fingerprint whatever the key order", async () => {
    // Otherwise "was this the same call as an hour ago" is unanswerable, which
    // is most of what an args hash is for — models don't serialise consistently.
    expect(argsHash({ a: 1, b: "x" })).toBe(argsHash({ b: "x", a: 1 }));
    expect(argsHash({ o: { p: 1, q: 2 } })).toBe(argsHash({ o: { q: 2, p: 1 } }));
  });

  it("distinguishes different calls, including array order", async () => {
    expect(argsHash({ query: "LED wall" })).not.toBe(argsHash({ query: "led wall" }));
    expect(argsHash({ zone: ["a", "b"] })).not.toBe(argsHash({ zone: ["b", "a"] }));
  });

  it("handles the shapes a tool call actually arrives in", async () => {
    for (const value of [undefined, null, {}, [], "text", 42, { nested: [{ a: null }] }]) {
      expect(argsHash(value)).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("treats an absent key and an explicitly-undefined one as the same call", async () => {
    expect(argsHash({ a: 1, b: undefined })).toBe(argsHash({ a: 1 }));
  });
});
