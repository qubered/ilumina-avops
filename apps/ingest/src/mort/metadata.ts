import type { FileRole } from "./types.js";

/**
 * Renders Mort's article metadata header (R3).
 *
 * Format is ProseMirror-safe `Key: value` lines separated by BLANK lines —
 * Outline collapses single-newline-separated lines onto one line, and a real
 * `---` YAML block renders as a horizontal rule. Verified by the round-trip
 * probe. The assistant's metadata.ts parses this key set (allow-list, any order)
 * and strips it from the body before chunking.
 *
 * Deterministic fields (Source-Files, Folder-Origin, Source-Tier, Maintained-By,
 * Updated) are injected by CODE — never invented by the model. The model only
 * supplies the semantic ones (Zone/System/Type/Entities).
 */

export type MortMeta = {
  zone?: string[];
  system?: string[];
  docType?: string | null;
  entities?: string[];
  sourceFiles?: string[];
  folderOrigin?: string | null;
  related?: string[];
  events?: string[];
  sourceTier?: string | null;
};

/** Map a file role onto the source-of-truth tier recorded in the header. */
export function roleToTier(role: FileRole): string | null {
  switch (role) {
    case "truth":
      return "word";
    case "structured":
      return "structured";
    case "reference":
      return "reference";
    case "media":
      return "media";
    case "event_log":
      return "event-log";
    default:
      return null;
  }
}

export function renderMetadataHeader(meta: MortMeta, opts?: { updated?: string }): string {
  const lines: string[] = [];
  const list = (key: string, vals?: string[]) => {
    const clean = (vals ?? []).map((v) => v.trim()).filter(Boolean);
    if (clean.length) lines.push(`${key}: ${clean.join(", ")}`);
  };
  const one = (key: string, val?: string | null) => {
    if (val && val.trim()) lines.push(`${key}: ${val.trim()}`);
  };

  list("Zone", meta.zone);
  list("System", meta.system);
  one("Type", meta.docType);
  list("Entities", meta.entities);
  list("Source-Files", meta.sourceFiles);
  one("Folder-Origin", meta.folderOrigin);
  list("Related", meta.related);
  list("Events", meta.events);
  one("Source-Tier", meta.sourceTier);
  lines.push("Maintained-By: Mort");
  one("Updated", opts?.updated ?? new Date().toISOString().slice(0, 10));

  return lines.join("\n\n");
}
