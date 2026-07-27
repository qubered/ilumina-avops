import { describe, expect, it } from "vitest";
import { mergeSources, parseTrailingSources, stripTrailingSourcesList } from "./sources";

const OUTLINE = "https://kb.venue.example";

describe("parseTrailingSources", () => {
  it("parses KB and web entries with kind classification", () => {
    const text = [
      "Steps here.",
      "",
      "Sources:",
      `- KB: **Patching a camera into the E2** — ${OUTLINE}/doc/patching-abc`,
      "- Barco official: **E2 Gen 2 - Presentation switchers** (web) — https://www.barco.com/en/product/e2-gen-2",
    ].join("\n");

    const sources = parseTrailingSources(text, OUTLINE);
    expect(sources).toEqual([
      {
        title: "Patching a camera into the E2",
        url: `${OUTLINE}/doc/patching-abc`,
        kind: "kb",
      },
      {
        title: "Barco official: E2 Gen 2 - Presentation switchers",
        url: "https://www.barco.com/en/product/e2-gen-2",
        kind: "web",
      },
    ]);
  });

  it("handles markdown links and numbered lists", () => {
    const text = `Answer.\n\nSources:\n1. [Audio show file](${OUTLINE}/doc/audio-1)\n2. [Shure manual](https://shure.com/manual)`;
    const sources = parseTrailingSources(text, OUTLINE);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ title: "Audio show file", kind: "kb" });
    expect(sources[1]).toMatchObject({ title: "Shure manual", kind: "web" });
  });

  it("falls back to hostname when a web line has no title", () => {
    const text = "Answer.\n\nSources:\n- https://www.barco.com/spec";
    expect(parseTrailingSources(text, OUTLINE)[0]).toMatchObject({
      title: "barco.com",
      kind: "web",
    });
  });

  it("returns nothing when there is no trailing list", () => {
    expect(parseTrailingSources("Just an answer.", OUTLINE)).toEqual([]);
    expect(
      parseTrailingSources("Sources: are documented in the KB.\nMore text after.", OUTLINE),
    ).toEqual([]);
  });
});

describe("stripTrailingSourcesList", () => {
  it("strips exactly the block the parser captures", () => {
    const text = "Answer.\n\nSources:\n- A — https://kb.venue.example/doc/a\n- B (web) — https://b.com";
    expect(stripTrailingSourcesList(text)).toBe("Answer.");
  });

  it("leaves mid-answer mentions of sources alone", () => {
    const text = "Sources: are documented in the KB.\nMore text after.";
    expect(stripTrailingSourcesList(text)).toBe(text);
  });
});

describe("mergeSources", () => {
  it("dedupes by url, first occurrence wins", () => {
    const merged = mergeSources(
      [{ title: "From tool", url: "https://x.com", kind: "kb" as const }],
      [{ title: "From text", url: "https://x.com", kind: "web" as const }],
      [{ title: "New", url: "https://y.com", kind: "web" as const }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0].title).toBe("From tool");
  });
});
