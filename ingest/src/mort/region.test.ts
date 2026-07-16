import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MORT_END,
  MORT_START,
  appendToFilesSection,
  extractMortRegion,
  hasMortRegion,
  isMalformedRegion,
  spliceMortRegion,
} from "./region.js";

test("empty doc → region block only", () => {
  const out = spliceMortRegion("", "Zone: Main Stage");
  assert.ok(out.includes(MORT_START) && out.includes(MORT_END));
  assert.equal(extractMortRegion(out), "Zone: Main Stage");
});

test("human content, no region → content preserved, region appended after", () => {
  const human = "# Human Procedure\n\nDo not touch this.";
  const out = spliceMortRegion(human, "Zone: Main Stage");
  assert.ok(out.startsWith(human), "human content preserved verbatim at the top");
  assert.equal(extractMortRegion(out), "Zone: Main Stage");
});

test("existing region → replaced; human content before AND after preserved byte-for-byte", () => {
  const before = "# Title\n\nHuman intro paragraph.\n\n";
  const after = "\n\n## Human appendix\n\nMore human words.";
  const doc = `${before}${MORT_START}\n\nold mort body\n\n${MORT_END}${after}`;
  const out = spliceMortRegion(doc, "new mort body");
  assert.ok(out.startsWith(before), "content before region untouched");
  assert.ok(out.endsWith(after), "content after region untouched");
  assert.equal(extractMortRegion(out), "new mort body");
  assert.ok(!out.includes("old mort body"), "old mort content gone");
});

test("re-splicing is idempotent on the human parts", () => {
  const doc = "Human A\n\n" + MORT_START + "\n\nv1\n\n" + MORT_END + "\n\nHuman B";
  const once = spliceMortRegion(doc, "v2");
  const twice = spliceMortRegion(once, "v3");
  assert.ok(twice.startsWith("Human A"));
  assert.ok(twice.endsWith("Human B"));
  assert.equal(extractMortRegion(twice), "v3");
  // exactly one region survives
  assert.equal(twice.split(MORT_START).length - 1, 1);
  assert.equal(twice.split(MORT_END).length - 1, 1);
});

test("hasMortRegion / extract", () => {
  assert.equal(hasMortRegion("no markers here"), false);
  assert.equal(extractMortRegion("no markers here"), null);
  assert.equal(hasMortRegion(`${MORT_START}\nx\n${MORT_END}`), true);
});

test("malformed region (stray start) is detected and refused", () => {
  const stray = "Human\n\n" + MORT_START + "\n\nunterminated";
  assert.equal(isMalformedRegion(stray), true);
  assert.throws(() => spliceMortRegion(stray, "body"), /malformed/);
});

test("end-before-start is malformed, not a valid region", () => {
  const reversed = MORT_END + "\n\nstuff\n\n" + MORT_START;
  assert.equal(isMalformedRegion(reversed), true);
});

test("mortBody is trimmed inside the region", () => {
  const out = spliceMortRegion("", "\n\n  padded body  \n\n");
  assert.equal(extractMortRegion(out), "padded body");
});

test("appendToFilesSection creates the heading, then appends under it, dedup", () => {
  const line1 = "- [MainStage_v4.show.gz](/api/attachments.redirect?id=abc)";
  const line2 = "- [MainStage_v5.show.gz](/api/attachments.redirect?id=def)";
  let region = "Zone: Main Stage\n\nSystem: Lighting";
  region = appendToFilesSection(region, line1);
  assert.ok(region.includes("## Files"));
  assert.ok(region.includes(line1));
  region = appendToFilesSection(region, line2);
  assert.equal(region.split("## Files").length - 1, 1, "only one Files heading");
  assert.ok(region.includes(line2));
  const again = appendToFilesSection(region, line1);
  assert.equal(again.split(line1).length - 1, 1, "no duplicate line");
});
