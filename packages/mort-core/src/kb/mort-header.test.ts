import { describe, expect, it } from "vitest";
import { parseMetadataBlock } from "./metadata";
import { renderMetadataHeader, restampHeader } from "./mort-header";

describe("restampHeader", () => {
  const existing = renderMetadataHeader(
    { zone: ["Main Stage"], system: ["Video"], entities: ["E2"], sourceFiles: ["Video/e2.docx"], sourceTier: "word" },
    { updated: "2026-01-01" },
  );
  const region = `${existing}\n\n## Patching\n\nStep one.`;

  it("keeps the body and unions the facets rather than replacing them", () => {
    const out = restampHeader(region, { system: ["Audio"], entities: ["DiGiCo"], sourceFiles: ["chat:abc"] });
    const { metadata, body } = parseMetadataBlock(out);

    expect(metadata.system).toEqual(["Video", "Audio"]);
    expect(metadata.entities).toEqual(["E2", "DiGiCo"]);
    expect(metadata.sourceFiles).toEqual(["Video/e2.docx", "chat:abc"]);
    // Facets the caller said nothing about survive untouched.
    expect(metadata.zone).toEqual(["Main Stage"]);
    expect(body).toBe("## Patching\n\nStep one.");
  });

  it("refreshes the Updated date rather than carrying a stale one forward", () => {
    const { metadata } = parseMetadataBlock(restampHeader(region, {}));
    expect(metadata.updated).toBe(new Date().toISOString().slice(0, 10));
  });

  it("does not duplicate a facet the model already carried forward", () => {
    const { metadata } = parseMetadataBlock(restampHeader(region, { system: ["Video"] }));
    expect(metadata.system).toEqual(["Video"]);
  });

  it("adds a header to a region body that has none", () => {
    const out = restampHeader("Just prose, no header.", { system: ["Lighting"], sourceFiles: ["chat:abc"] });
    const { metadata, body } = parseMetadataBlock(out);
    expect(metadata.system).toEqual(["Lighting"]);
    expect(metadata.maintainedBy).toBe("Mort");
    expect(body).toBe("Just prose, no header.");
  });
});
