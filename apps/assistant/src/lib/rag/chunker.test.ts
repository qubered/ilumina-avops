import { describe, expect, it } from "vitest";
import { chunkMarkdown, estimateTokens, splitSections, TARGET_TOKENS } from "./chunker";

describe("splitSections", () => {
  it("tracks heading paths across levels", () => {
    const md = [
      "Intro text.",
      "# Video",
      "Video overview.",
      "## E2 patching",
      "Patch steps.",
      "## Cameras",
      "Camera notes.",
      "# Audio",
      "Audio overview.",
    ].join("\n");

    const sections = splitSections(md);
    expect(sections.map((s) => s.path)).toEqual([
      [],
      ["Video"],
      ["Video", "E2 patching"],
      ["Video", "Cameras"],
      ["Audio"],
    ]);
  });

  it("ignores heading-like lines inside code fences", () => {
    const md = ["# Real heading", "```", "# not a heading", "```", "tail"].join("\n");
    const sections = splitSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].path).toEqual(["Real heading"]);
    expect(sections[0].content).toContain("# not a heading");
  });

  it("does not split on ##### (deeper than 4)", () => {
    const md = ["# Top", "##### tiny heading", "body"].join("\n");
    const sections = splitSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain("##### tiny heading");
  });
});

describe("chunkMarkdown", () => {
  it("prefixes every chunk with a breadcrumb", () => {
    const md = ["# Setup", "Do the thing.", "## Details", "More things."].join("\n");
    const chunks = chunkMarkdown("E2 Guide", md);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith("[E2 Guide")).toBe(true);
      expect(chunk.text.split("\n")[0]).toBe(chunk.breadcrumb);
    }
    expect(chunks.some((c) => c.breadcrumb === "[E2 Guide › Setup]")).toBe(true);
  });

  it("splits oversized sections on paragraph boundaries with overlap", () => {
    const para = "word ".repeat(150).trim(); // ~187 tokens each
    const md = `# Big\n${[1, 2, 3, 4, 5].map((i) => `Paragraph ${i}: ${para}`).join("\n\n")}`;
    const chunks = chunkMarkdown("Doc", md);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(TARGET_TOKENS * 1.6);
    }
    // Overlap: the second chunk starts with the tail of the first.
    const firstBody = chunks[0].text.split("\n").slice(1).join("\n");
    const secondBody = chunks[1].text.split("\n").slice(1).join("\n");
    const tail = firstBody.slice(-80);
    expect(secondBody).toContain(tail.slice(tail.indexOf(" ") + 1, tail.indexOf(" ") + 30));
  });

  it("merges tiny adjacent chunks", () => {
    const md = ["# A", "Tiny.", "# B", "Also tiny.", "# C", "Small."].join("\n");
    const chunks = chunkMarkdown("Doc", md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Tiny.");
    expect(chunks[0].text).toContain("Also tiny.");
    expect(chunks[0].text).toContain("Small.");
    // Absorbed sections keep their heading context inline.
    expect(chunks[0].text).toContain("[Doc › B]");
  });

  it("returns no chunks for empty documents", () => {
    expect(chunkMarkdown("Doc", "")).toEqual([]);
    expect(chunkMarkdown("Doc", "\n\n\n")).toEqual([]);
  });
});
