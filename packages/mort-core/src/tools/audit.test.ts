import { describe, expect, it } from "vitest";
import { hashArgs } from "./audit";

describe("hashArgs", () => {
  it("hashes the same call the same however the model ordered the keys", () => {
    // Without canonical ordering, "is this the same call as last time?" answers
    // no every time and the digest is worth nothing.
    expect(hashArgs({ outlet: 3, rack: "A" })).toBe(hashArgs({ rack: "A", outlet: 3 }));
  });

  it("distinguishes calls that differ", () => {
    expect(hashArgs({ outlet: 3 })).not.toBe(hashArgs({ outlet: 4 }));
    expect(hashArgs({})).not.toBe(hashArgs({ outlet: 3 }));
  });

  it("recurses into nested objects and keeps array order significant", () => {
    expect(hashArgs({ a: { x: 1, y: 2 } })).toBe(hashArgs({ a: { y: 2, x: 1 } }));
    // Order within an array is part of the value, not incidental.
    expect(hashArgs({ a: [1, 2] })).not.toBe(hashArgs({ a: [2, 1] }));
  });

  it("reveals nothing about what was passed", () => {
    const digest = hashArgs({ token: "sk-live-abc123", outlet: 3 });
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(digest).not.toContain("sk-live");
  });
});
