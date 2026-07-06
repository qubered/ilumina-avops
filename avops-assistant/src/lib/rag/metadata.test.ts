import { describe, expect, it } from "vitest";
import { parseMetadataBlock } from "./metadata";

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
    expect(metadata).toEqual({ zone: [], system: [], docType: [] });
    expect(body).toBe(md);
  });

  it("does not treat mid-document Zone lines as metadata", () => {
    const md = "Intro paragraph.\nZone: PFA";
    const { metadata, body } = parseMetadataBlock(md);
    expect(metadata.zone).toEqual([]);
    expect(body).toBe(md);
  });
});
