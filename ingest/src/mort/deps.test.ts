import { test } from "node:test";
import assert from "node:assert/strict";
import { metaField, slugify } from "./textutil.js";

test("slugify normalises titles", () => {
  assert.equal(slugify("Main Stage — Lighting"), "main-stage-lighting");
  assert.equal(slugify("E2 Camera Patching!"), "e2-camera-patching");
  assert.equal(slugify("   "), "doc");
});

test("metaField reads a Key: value line from the region body", () => {
  const body = "Zone: Main Stage\n\nSystem: Lighting\n\nType: Procedure\n\n## Body";
  assert.equal(metaField(body, "System"), "Lighting");
  assert.equal(metaField(body, "zone"), "Main Stage"); // case-insensitive
  assert.equal(metaField(body, "Missing"), null);
});
