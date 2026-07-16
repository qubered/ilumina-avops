import { createHash } from "node:crypto";
import * as XLSX from "xlsx";

/**
 * Event-log ingestion (MORT_PLAN R1). A designated actions spreadsheet is
 * ingested ROW-BY-ROW into episodic memory — one row is a dated observation
 * ("Raised LED wall to 2.5m"), NOT a KB page. The whole sheet is re-sent on any
 * edit, so ingestion is set-reconciliation keyed on a per-row hash: new rows
 * insert, rows gone from the sheet are purged.
 */

export type EventRow = {
  rowHash: string;
  event: string | null;
  occurredOn: string | null; // ISO yyyy-mm-dd
  zone: string[];
  system: string[];
  entities: string[];
  actionText: string;
};

// Column header synonyms — matched case-insensitively, exact then substring.
const COLS = {
  date: ["date", "when", "day"],
  event: ["event", "show", "job", "gig", "production"],
  zone: ["zone", "area", "room", "location"],
  system: ["system", "discipline", "department", "dept"],
  entities: ["entities", "gear", "equipment", "kit"],
  action: ["action", "task", "description", "notes", "note", "work", "activity", "detail", "details"],
};

function findCol(headers: string[], names: string[]): number {
  const lower = headers.map((h) => String(h).trim().toLowerCase());
  for (const n of names) {
    const i = lower.indexOf(n);
    if (i >= 0) return i;
  }
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] && names.some((n) => lower[i].includes(n))) return i;
  }
  return -1;
}

function splitList(v: string): string[] {
  return String(v || "")
    .split(/[,;/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toISODate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Parse the first sheet of an events workbook into typed rows. */
export function parseEventRows(buffer: Buffer): EventRow[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" });
  if (rows.length < 2) return [];

  const headers = (rows[0] as unknown[]).map((h) => String(h ?? ""));
  const ci = {
    date: findCol(headers, COLS.date),
    event: findCol(headers, COLS.event),
    zone: findCol(headers, COLS.zone),
    system: findCol(headers, COLS.system),
    entities: findCol(headers, COLS.entities),
    action: findCol(headers, COLS.action),
  };

  const out: EventRow[] = [];
  for (const raw of rows.slice(1)) {
    const cells = raw as unknown[];
    const cell = (i: number) => (i >= 0 ? String(cells[i] ?? "").trim() : "");
    const actionText =
      ci.action >= 0
        ? cell(ci.action)
        : cells.map((c) => String(c ?? "").trim()).filter(Boolean).join(" · ");
    if (!actionText) continue; // skip blank rows
    const rowHash = createHash("sha256").update(JSON.stringify(cells.map((c) => String(c ?? "")))).digest("hex");
    out.push({
      rowHash,
      event: ci.event >= 0 ? cell(ci.event) || null : null,
      occurredOn: ci.date >= 0 ? toISODate(cells[ci.date]) : null,
      zone: ci.zone >= 0 ? splitList(cell(ci.zone)) : [],
      system: ci.system >= 0 ? splitList(cell(ci.system)) : [],
      entities: ci.entities >= 0 ? splitList(cell(ci.entities)) : [],
      actionText,
    });
  }
  return out;
}

/** Set-diff current row hashes against the stored ones. */
export function diffEventHashes(current: string[], existing: string[]): { insert: Set<string>; deleteHashes: string[] } {
  const cur = new Set(current);
  const ex = new Set(existing);
  return {
    insert: new Set([...cur].filter((h) => !ex.has(h))),
    deleteHashes: [...ex].filter((h) => !cur.has(h)),
  };
}

export type EventSyncDeps = {
  getHashes: (sourceId: string) => Promise<string[]>;
  insertRow: (sourceId: string, row: EventRow) => Promise<void>;
  deleteHashes: (sourceId: string, hashes: string[]) => Promise<void>;
};

export type EventSyncResult = {
  inserted: number;
  deleted: number;
  total: number;
  guarded: boolean;
  /** Rows newly inserted this run — forwarded to the assistant for embedding. */
  insertedRows: EventRow[];
  /** All current row hashes — the assistant prunes vectors not in this set. */
  currentHashes: string[];
};

/**
 * Reconcile an events sheet into episodic memory. Bulk-delete guardrail: an
 * empty/parse-failed sheet does NOT purge existing rows (a corrupt upload
 * shouldn't wipe the log).
 */
export async function syncEventSheet(sourceId: string, buffer: Buffer, deps: EventSyncDeps): Promise<EventSyncResult> {
  const rows = parseEventRows(buffer);
  const existing = await deps.getHashes(sourceId);
  const currentHashes = rows.map((r) => r.rowHash);

  if (rows.length === 0 && existing.length > 0) {
    return { inserted: 0, deleted: 0, total: 0, guarded: true, insertedRows: [], currentHashes };
  }

  const { insert, deleteHashes } = diffEventHashes(currentHashes, existing);
  const insertedRows = rows.filter((r) => insert.has(r.rowHash));
  for (const r of insertedRows) await deps.insertRow(sourceId, r);
  if (deleteHashes.length) await deps.deleteHashes(sourceId, deleteHashes);

  return { inserted: insert.size, deleted: deleteHashes.length, total: rows.length, guarded: false, insertedRows, currentHashes };
}
