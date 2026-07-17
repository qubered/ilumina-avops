/**
 * Leading metadata block parser. Mort writes a ProseMirror-safe `Key: value`
 * header (blank-line separated — Outline collapses single newlines) at the top of
 * the pages it maintains; this parses it and strips it from the body so the
 * header never pollutes chunk text.
 *
 * Keys are an explicit ALLOW-LIST, parsed in ANY order. Both matter: a body
 * paragraph like "Note: check the rigging" must NOT be swallowed as metadata, and
 * a header leading with Mort-ID must not stop the parser dead (which would leave
 * the whole doc unparsed and de-index its metadata). Legacy pages carrying only
 * Zone/System/Type still parse unchanged.
 */

export type DocMetadata = {
  // Legacy trio (existing pages only have these).
  zone: string[];
  system: string[];
  docType: string[];
  // Mort's richer header.
  entities: string[];
  sourceFiles: string[];
  related: string[];
  attachments: string[];
  events: string[];
  mortId: string | null;
  folderOrigin: string | null;
  sourceTier: string | null;
  maintainedBy: string | null;
  updated: string | null;
  confidence: string | null;
};

const LIST_KEYS = {
  zone: "zone",
  system: "system",
  type: "docType",
  entities: "entities",
  "source-files": "sourceFiles",
  related: "related",
  attachments: "attachments",
  events: "events",
} as const;

const SCALAR_KEYS = {
  "mort-id": "mortId",
  "folder-origin": "folderOrigin",
  "source-tier": "sourceTier",
  "maintained-by": "maintainedBy",
  updated: "updated",
  confidence: "confidence",
} as const;

const KNOWN_KEYS = new Set<string>([...Object.keys(LIST_KEYS), ...Object.keys(SCALAR_KEYS)]);
const META_LINE_RE = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.+)$/;

export function emptyMetadata(): DocMetadata {
  return {
    zone: [],
    system: [],
    docType: [],
    entities: [],
    sourceFiles: [],
    related: [],
    attachments: [],
    events: [],
    mortId: null,
    folderOrigin: null,
    sourceTier: null,
    maintainedBy: null,
    updated: null,
    confidence: null,
  };
}

export function parseMetadataBlock(markdown: string): {
  metadata: DocMetadata;
  body: string;
} {
  const metadata = emptyMetadata();
  const lines = markdown.split("\n");
  let consumed = 0;
  let found = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      consumed++; // blank lines separate header entries
      continue;
    }
    const match = trimmed.match(META_LINE_RE);
    if (!match) break;
    const key = match[1].toLowerCase();
    if (!KNOWN_KEYS.has(key)) break; // unknown key ⇒ the body has started
    const raw = match[2].trim();

    if (key in LIST_KEYS) {
      const field = LIST_KEYS[key as keyof typeof LIST_KEYS];
      metadata[field].push(...raw.split(",").map((v) => v.trim()).filter(Boolean));
    } else {
      const field = SCALAR_KEYS[key as keyof typeof SCALAR_KEYS];
      metadata[field] = raw;
    }
    found = true;
    consumed++;
  }

  return {
    metadata,
    body: found ? lines.slice(consumed).join("\n").trimStart() : markdown,
  };
}
