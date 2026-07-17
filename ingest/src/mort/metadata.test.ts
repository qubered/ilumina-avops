import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMetadataHeader, roleToTier } from "./metadata.js";

test("renders blank-line-separated Key: value lines (ProseMirror-safe)", () => {
  const h = renderMetadataHeader(
    {
      zone: ["Main Stage"],
      system: ["Lighting"],
      docType: "Reference",
      entities: ["grandMA3", "LED wall"],
      sourceFiles: ["Main Stage Lighting.docx"],
      folderOrigin: "Lighting/Main Stage",
      sourceTier: "word",
    },
    { updated: "2026-07-16" },
  );
  // Every entry separated by a blank line — Outline collapses single newlines.
  assert.ok(h.includes("Zone: Main Stage\n\nSystem: Lighting"));
  assert.ok(h.includes("Entities: grandMA3, LED wall"));
  assert.ok(h.includes("Source-Files: Main Stage Lighting.docx"));
  assert.ok(h.includes("Folder-Origin: Lighting/Main Stage"));
  assert.ok(h.includes("Source-Tier: word"));
  assert.ok(h.includes("Maintained-By: Mort"));
  assert.ok(h.includes("Updated: 2026-07-16"));
  assert.ok(!h.includes("\n\n\n"), "no double blank lines");
});

test("omits empty fields entirely", () => {
  const h = renderMetadataHeader({ zone: [], system: [], docType: null, entities: [] }, { updated: "2026-07-16" });
  assert.ok(!h.includes("Zone:"));
  assert.ok(!h.includes("Entities:"));
  assert.ok(h.includes("Maintained-By: Mort"));
});

test("roleToTier maps roles onto source-of-truth tiers", () => {
  assert.equal(roleToTier("truth"), "word");
  assert.equal(roleToTier("structured"), "structured");
  assert.equal(roleToTier("reference"), "reference");
  assert.equal(roleToTier("media"), "media");
  assert.equal(roleToTier("event_log"), "event-log");
  assert.equal(roleToTier("unknown"), null);
});
