import { describe, expect, it } from "vitest";
import { emptyMetadata, parseMetadataBlock } from "./metadata";

describe("parseMetadataBlock", () => {
  it("parses Zone/System/Type lines and strips them from the body", () => {
    const md = [
      "Zone: PFA, Main Room",
      "System: Video",
      "Type: How-to",
      "",
      "# Patching",
      "Steps here.",
    ].join("\n");

    const { metadata, body } = parseMetadataBlock(md);
    expect(metadata.zone).toEqual(["PFA", "Main Room"]);
    expect(metadata.system).toEqual(["Video"]);
    expect(metadata.docType).toEqual(["How-to"]);
    expect(body.startsWith("# Patching")).toBe(true);
    expect(body).not.toContain("Zone:");
  });

  it("is case-insensitive", () => {
    const { metadata } = parseMetadataBlock("zone: pfa\nSYSTEM: Audio\n\nBody");
    expect(metadata.zone).toEqual(["pfa"]);
    expect(metadata.system).toEqual(["Audio"]);
  });

  it("leaves documents without a metadata block untouched", () => {
    const md = "# Title\nSome content with a colon: yes.";
    const { metadata, body } = parseMetadataBlock(md);
    expect(metadata).toEqual(emptyMetadata());
    expect(body).toBe(md);
  });

  it("does not treat mid-document Zone lines as metadata", () => {
    const md = "Intro paragraph.\nZone: PFA";
    const { metadata, body } = parseMetadataBlock(md);
    expect(metadata.zone).toEqual([]);
    expect(body).toBe(md);
  });

  // --- Mort's rich header (R3) ---

  it("parses Mort's full header in any order, blank-line separated", () => {
    const md = [
      "Mort-ID: main-stage-lighting-ab12cd",
      "",
      "Zone: Main Stage",
      "",
      "System: Lighting",
      "",
      "Type: Reference",
      "",
      "Entities: grandMA3, LED wall",
      "",
      "Source-Files: Main Stage Lighting.docx, MainStage_v4.show.gz",
      "",
      "Folder-Origin: Lighting/Main Stage",
      "",
      "Source-Tier: word",
      "",
      "Maintained-By: Mort",
      "",
      "Updated: 2026-07-16",
      "",
      "## Mort — maintained section",
      "",
      "Body prose.",
    ].join("\n");

    const { metadata, body } = parseMetadataBlock(md);
    expect(metadata.mortId).toBe("main-stage-lighting-ab12cd");
    expect(metadata.zone).toEqual(["Main Stage"]);
    expect(metadata.entities).toEqual(["grandMA3", "LED wall"]);
    expect(metadata.sourceFiles).toEqual(["Main Stage Lighting.docx", "MainStage_v4.show.gz"]);
    expect(metadata.folderOrigin).toBe("Lighting/Main Stage");
    expect(metadata.sourceTier).toBe("word");
    expect(metadata.maintainedBy).toBe("Mort");
    expect(metadata.updated).toBe("2026-07-16");
    // The header must be stripped — none of it should reach the chunk text.
    expect(body.startsWith("## Mort — maintained section")).toBe(true);
    expect(body).not.toContain("Mort-ID:");
    expect(body).not.toContain("Source-Files:");
  });

  it("a header leading with Mort-ID still parses the keys after it (regression)", () => {
    // The old parser broke at the first non-Zone/System/Type key, leaving the
    // whole doc unparsed and de-indexing its metadata.
    const { metadata, body } = parseMetadataBlock("Mort-ID: x\n\nZone: Main Stage\n\n# Body");
    expect(metadata.mortId).toBe("x");
    expect(metadata.zone).toEqual(["Main Stage"]);
    expect(body).toBe("# Body");
  });

  it("an unknown Key: line ends the header and stays in the body", () => {
    const { metadata, body } = parseMetadataBlock("Zone: Main Stage\n\nNote: check the rigging\n\nMore body.");
    expect(metadata.zone).toEqual(["Main Stage"]);
    expect(body.startsWith("Note: check the rigging")).toBe(true);
  });
});
