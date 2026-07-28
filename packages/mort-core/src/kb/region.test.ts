import { describe, expect, it } from "vitest";
import {
  MORT_END,
  MORT_START,
  appendToFilesSection,
  extractMortRegion,
  hasMortRegion,
  isMalformedRegion,
  spliceMortRegion,
} from "./region";

describe("region splicing", () => {
  it("empty doc → region block only", () => {
    const out = spliceMortRegion("", "Zone: Main Stage");
    expect(out.includes(MORT_START) && out.includes(MORT_END)).toBe(true);
    expect(extractMortRegion(out)).toBe("Zone: Main Stage");
  });

  it("human content, no region → content preserved, region appended after", () => {
    const human = "# Human Procedure\n\nDo not touch this.";
    const out = spliceMortRegion(human, "Zone: Main Stage");
    expect(out.startsWith(human)).toBe(true);
    expect(extractMortRegion(out)).toBe("Zone: Main Stage");
  });

  it("existing region → replaced; human content before AND after preserved byte-for-byte", () => {
    const before = "# Title\n\nHuman intro paragraph.\n\n";
    const after = "\n\n## Human appendix\n\nMore human words.";
    const doc = `${before}${MORT_START}\n\nold mort body\n\n${MORT_END}${after}`;
    const out = spliceMortRegion(doc, "new mort body");
    expect(out.startsWith(before)).toBe(true);
    expect(out.endsWith(after)).toBe(true);
    expect(extractMortRegion(out)).toBe("new mort body");
    expect(out.includes("old mort body")).toBe(false);
  });

  it("re-splicing is idempotent on the human parts", () => {
    const doc = "Human A\n\n" + MORT_START + "\n\nv1\n\n" + MORT_END + "\n\nHuman B";
    const once = spliceMortRegion(doc, "v2");
    const twice = spliceMortRegion(once, "v3");
    expect(twice.startsWith("Human A")).toBe(true);
    expect(twice.endsWith("Human B")).toBe(true);
    expect(extractMortRegion(twice)).toBe("v3");
    // exactly one region survives
    expect(twice.split(MORT_START).length - 1).toBe(1);
    expect(twice.split(MORT_END).length - 1).toBe(1);
  });

  it("hasMortRegion / extract", () => {
    expect(hasMortRegion("no markers here")).toBe(false);
    expect(extractMortRegion("no markers here")).toBe(null);
    expect(hasMortRegion(`${MORT_START}\nx\n${MORT_END}`)).toBe(true);
  });

  it("malformed region (stray start) is detected and refused", () => {
    const stray = "Human\n\n" + MORT_START + "\n\nunterminated";
    expect(isMalformedRegion(stray)).toBe(true);
    expect(() => spliceMortRegion(stray, "body")).toThrow(/malformed/);
  });

  it("end-before-start is malformed, not a valid region", () => {
    const reversed = MORT_END + "\n\nstuff\n\n" + MORT_START;
    expect(isMalformedRegion(reversed)).toBe(true);
  });

  it("mortBody is trimmed inside the region", () => {
    const out = spliceMortRegion("", "\n\n  padded body  \n\n");
    expect(extractMortRegion(out)).toBe("padded body");
  });

  it("appendToFilesSection creates the heading, then appends under it, dedup", () => {
    const line1 = "- [MainStage_v4.show.gz](/api/attachments.redirect?id=abc)";
    const line2 = "- [MainStage_v5.show.gz](/api/attachments.redirect?id=def)";
    let region = "Zone: Main Stage\n\nSystem: Lighting";
    region = appendToFilesSection(region, line1);
    expect(region.includes("## Files")).toBe(true);
    expect(region.includes(line1)).toBe(true);
    region = appendToFilesSection(region, line2);
    expect(region.split("## Files").length - 1).toBe(1);
    expect(region.includes(line2)).toBe(true);
    const again = appendToFilesSection(region, line1);
    expect(again.split(line1).length - 1).toBe(1);
  });
});
