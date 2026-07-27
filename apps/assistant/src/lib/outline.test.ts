import { describe, expect, it } from "vitest";
import { shouldIndexDocument } from "./outline";

const published = {
  template: false,
  archivedAt: null,
  deletedAt: null,
  publishedAt: "2026-01-01T00:00:00Z",
};

describe("shouldIndexDocument", () => {
  it("indexes published, non-template, non-archived docs", () => {
    expect(shouldIndexDocument(published)).toBe(true);
  });

  it("skips templates", () => {
    expect(shouldIndexDocument({ ...published, template: true })).toBe(false);
  });

  it("skips archived docs", () => {
    expect(
      shouldIndexDocument({ ...published, archivedAt: "2026-02-01T00:00:00Z" }),
    ).toBe(false);
  });

  it("skips deleted docs", () => {
    expect(
      shouldIndexDocument({ ...published, deletedAt: "2026-02-01T00:00:00Z" }),
    ).toBe(false);
  });

  it("skips drafts (publishedAt null) — the crew-ready gate", () => {
    expect(shouldIndexDocument({ ...published, publishedAt: null })).toBe(false);
  });
});
