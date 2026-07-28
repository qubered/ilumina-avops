import { describe, expect, it } from "vitest";
import { condenseDiff, diffLines, diffStat } from "./diff";

describe("diffLines", () => {
  it("reports no changes for identical text", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d.every((l) => l.kind === "context")).toBe(true);
    expect(diffStat(d)).toEqual({ added: 0, removed: 0, changed: false });
  });

  it("shows an inserted line as an addition, keeping the rest as context", () => {
    const d = diffLines("a\nc", "a\nb\nc");
    expect(d).toEqual([
      { kind: "context", text: "a" },
      { kind: "add", text: "b" },
      { kind: "context", text: "c" },
    ]);
  });

  it("shows a replaced line as remove + add", () => {
    const d = diffLines("patch 3", "patch 7");
    expect(diffStat(d)).toEqual({ added: 1, removed: 1, changed: true });
  });

  it("handles an empty before (new page) as all additions", () => {
    const d = diffLines("", "line one\nline two");
    expect(d.every((l) => l.kind === "add")).toBe(true);
    expect(diffStat(d).added).toBe(2);
  });

  it("handles an emptied after as all removals", () => {
    const d = diffLines("gone\nalso gone", "");
    expect(diffStat(d)).toEqual({ added: 0, removed: 2, changed: true });
  });

  it("falls back to wholesale replace past the LCS cap", () => {
    const before = Array.from({ length: 500 }, (_, i) => `b${i}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `a${i}`).join("\n");
    const stat = diffStat(diffLines(before, after));
    expect(stat).toEqual({ added: 500, removed: 500, changed: true });
  });
});

describe("condenseDiff", () => {
  it("elides long unchanged runs but keeps context around each change", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
    const after = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "TEN"].join("\n");
    const condensed = condenseDiff(diffLines(before, after), 2);

    expect(condensed[0]).toEqual({ kind: "context", text: "…" });
    expect(condensed.some((l) => l.kind === "remove" && l.text === "10")).toBe(true);
    expect(condensed.some((l) => l.kind === "add" && l.text === "TEN")).toBe(true);
    // Ellipsis + the two context lines before the change + remove + add.
    expect(condensed).toEqual([
      { kind: "context", text: "…" },
      { kind: "context", text: "8" },
      { kind: "context", text: "9" },
      { kind: "remove", text: "10" },
      { kind: "add", text: "TEN" },
    ]);
  });

  it("leaves a fully-changed diff alone", () => {
    const lines = diffLines("a", "b");
    expect(condenseDiff(lines)).toEqual(lines);
  });
});
