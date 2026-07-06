/**
 * Optional metadata block parser (build brief §6.1): if a doc's first lines
 * match `Zone: ...` / `System: ...` / `Type: ...` (case-insensitive, values
 * comma-splittable), parse them into metadata and strip them from the body.
 */

export type DocMetadata = {
  zone: string[];
  system: string[];
  docType: string[];
};

const META_LINE_RE = /^(zone|system|type)\s*:\s*(.+)$/i;

export function parseMetadataBlock(markdown: string): {
  metadata: DocMetadata;
  body: string;
} {
  const metadata: DocMetadata = { zone: [], system: [], docType: [] };
  const lines = markdown.split("\n");
  let consumed = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Allow blank lines between/after metadata lines only if we've matched
      // something already; a leading blank line is also fine to skip.
      consumed++;
      continue;
    }
    const match = trimmed.match(META_LINE_RE);
    if (!match) break;
    const key = match[1].toLowerCase();
    const values = match[2]
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (key === "zone") metadata.zone.push(...values);
    else if (key === "system") metadata.system.push(...values);
    else metadata.docType.push(...values);
    consumed++;
  }

  const hasMetadata =
    metadata.zone.length > 0 ||
    metadata.system.length > 0 ||
    metadata.docType.length > 0;

  return {
    metadata,
    body: hasMetadata ? lines.slice(consumed).join("\n").trimStart() : markdown,
  };
}
