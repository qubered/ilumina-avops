import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { diffEventHashes, parseEventRows, syncEventSheet } from "./events.js";

function xlsxBuffer(aoa: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Log");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("parseEventRows maps Date/Event/Zone/System/Action columns", () => {
  const buf = xlsxBuffer([
    ["Date", "Event", "Zone", "System", "Action"],
    ["2026-07-10", "Milli", "Main Stage", "Video", "Ran SDI cable for Milli machines under floor"],
    ["2026-07-12", "Milli", "Main Stage", "Lighting", "Raised LED wall to 2.5m"],
  ]);
  const rows = parseEventRows(buf);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actionText, "Ran SDI cable for Milli machines under floor");
  assert.equal(rows[0].event, "Milli");
  assert.deepEqual(rows[0].zone, ["Main Stage"]);
  assert.deepEqual(rows[0].system, ["Video"]);
  assert.equal(rows[0].occurredOn, "2026-07-10");
  assert.notEqual(rows[0].rowHash, rows[1].rowHash);
});

test("parseEventRows without an Action column joins the row", () => {
  const buf = xlsxBuffer([
    ["Foo", "Bar"],
    ["a", "b"],
  ]);
  const rows = parseEventRows(buf);
  assert.equal(rows[0].actionText, "a · b");
});

test("parseEventRows skips blank rows and header-only sheets", () => {
  assert.equal(parseEventRows(xlsxBuffer([["Action"]])).length, 0);
});

test("diffEventHashes computes inserts and deletes", () => {
  const d = diffEventHashes(["a", "b", "c"], ["b", "c", "d"]);
  assert.deepEqual([...d.insert], ["a"]);
  assert.deepEqual(d.deleteHashes, ["d"]);
});

test("syncEventSheet inserts new rows and purges rows gone from the sheet", async () => {
  const buf = xlsxBuffer([["Action"], ["do X"], ["do Y"]]);
  const inserted: string[] = [];
  const deleted: string[] = [];
  const res = await syncEventSheet("Site/Events.xlsx", buf, {
    getHashes: async () => ["stale-hash"],
    insertRow: async (_s, r) => {
      inserted.push(r.actionText);
    },
    deleteHashes: async (_s, h) => {
      deleted.push(...h);
    },
  });
  assert.equal(res.inserted, 2);
  assert.equal(res.deleted, 1);
  assert.deepEqual(inserted.sort(), ["do X", "do Y"]);
  assert.deepEqual(deleted, ["stale-hash"]);
});

test("syncEventSheet guardrail: an empty sheet does NOT purge existing rows", async () => {
  const buf = xlsxBuffer([["Action"]]); // headers only
  let deleteCalled = false;
  const res = await syncEventSheet("Site/Events.xlsx", buf, {
    getHashes: async () => ["h1", "h2"],
    insertRow: async () => {},
    deleteHashes: async () => {
      deleteCalled = true;
    },
  });
  assert.equal(res.guarded, true);
  assert.equal(res.deleted, 0);
  assert.equal(deleteCalled, false);
});

test("syncEventSheet re-send with no changes is a no-op", async () => {
  const buf = xlsxBuffer([["Action"], ["do X"]]);
  const hashes = parseEventRows(buf).map((r) => r.rowHash);
  let touched = 0;
  const res = await syncEventSheet("Site/Events.xlsx", buf, {
    getHashes: async () => hashes,
    insertRow: async () => {
      touched++;
    },
    deleteHashes: async () => {
      touched++;
    },
  });
  assert.equal(res.inserted, 0);
  assert.equal(res.deleted, 0);
  assert.equal(touched, 0);
});
