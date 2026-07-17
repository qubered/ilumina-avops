import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRole } from "./classify.js";

const cases: Array<[string, string | undefined, string | undefined, string]> = [
  // fileName, contentType, folderPath, expected role
  ["E2 Camera Patching.docx", undefined, undefined, "truth"],
  ["notes.md", undefined, undefined, "truth"],
  ["runsheet.pdf", undefined, undefined, "truth"],
  ["Patch Sheet.xlsx", undefined, undefined, "structured"],
  ["vlans.csv", undefined, undefined, "structured"],
  ["2026 Events Log.xlsx", undefined, undefined, "event_log"],
  ["log.csv", undefined, "Site/Actions", "event_log"],
  ["MainStage_v4.show.gz", undefined, undefined, "reference"],
  ["rig.mvr", undefined, undefined, "reference"],
  ["stage.jpg", undefined, undefined, "media"],
  ["briefing.pptx", undefined, undefined, "reference"],
  ["firmware.bin", "application/octet-stream", undefined, "reference"],
  ["mystery", undefined, undefined, "unknown"],
];

for (const [fileName, contentType, folderPath, expected] of cases) {
  test(`classify ${fileName}${folderPath ? ` in ${folderPath}` : ""} → ${expected}`, () => {
    assert.equal(classifyRole({ fileName, contentType, folderPath }), expected);
  });
}

test("event_log needs the designation, not just a spreadsheet", () => {
  assert.equal(classifyRole({ fileName: "budget.xlsx" }), "structured");
});
