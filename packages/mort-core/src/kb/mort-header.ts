import type { FileRole } from "../memory/types";
import { parseMetadataBlock } from "./metadata";

/**
 * Renders Mort's article metadata header (MORT_PLAN R3).
 *
 * Format is ProseMirror-safe `Key: value` lines separated by BLANK lines —
 * Outline collapses single-newline-separated lines onto one line, and a real
 * `---` YAML block renders as a horizontal rule. Verified by the round-trip
 * probe. kb/metadata.ts parses this key set (allow-list, any order) and strips
 * it from the body before chunking.
 *
 * Deterministic fields (Source-Files, Folder-Origin, Source-Tier, Maintained-By,
 * Updated) are injected by CODE — never invented by the model. The model only
 * supplies the semantic ones (Zone/System/Type/Entities).
 *
 * Lives in core (v2/P3) because chat now authors pages too: a page Mort writes
 * from a conversation must carry the same header as one he writes from a file,
 * or the two halves of the KB stop being one KB.
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

const union = (...lists: Array<string[] | undefined>): string[] => [
  ...new Set(lists.flatMap((l) => l ?? []).map((s) => s.trim()).filter(Boolean)),
];

/**
 * Re-stamp a region body's header: parse whatever header it already carries,
 * union in the new facets and source, and re-render — so `Updated` is today's
 * date and the deterministic fields stay code-authored rather than whatever the
 * model happened to copy forward.
 *
 * Used when a chat edit rewrites an existing region: the model is shown the
 * current region (header included) and returns a merged one, and this makes
 * sure the merge didn't quietly drop a facet or freeze the date.
 */
export function restampHeader(regionBody: string, add: MortMeta): string {
  const { metadata, body } = parseMetadataBlock(regionBody);
  const header = renderMetadataHeader({
    zone: union(metadata.zone, add.zone),
    system: union(metadata.system, add.system),
    docType: add.docType ?? metadata.docType[0] ?? null,
    entities: union(metadata.entities, add.entities),
    sourceFiles: union(metadata.sourceFiles, add.sourceFiles),
    folderOrigin: add.folderOrigin ?? metadata.folderOrigin,
    related: union(metadata.related, add.related),
    events: union(metadata.events, add.events),
    sourceTier: add.sourceTier ?? metadata.sourceTier,
  });
  return [header, body.trim()].filter(Boolean).join("\n\n");
}
