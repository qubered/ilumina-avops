import type { Source } from "../db/schema";

/**
 * The system prompt makes the model end answers with a "Sources:" list. The
 * UI renders citations as structured rows instead, so:
 *  - at persist time the trailing list is PARSED into structured sources
 *    (needed on providers whose web search returns no citation annotations,
 *    e.g. the Codex backend), then
 *  - at render time the now-redundant text list is STRIPPED.
 * Same block regex for both so nothing is stripped that wasn't captured.
 */
const TRAILING_SOURCES_RE =
  /\n+(?:#{1,4}\s*)?(?:\*\*)?Sources:?(?:\*\*)?\s*\n(?:\s*(?:[-*•]|\d+\.)\s+.*\n?)*\s*$/i;

export function stripTrailingSourcesList(text: string): string {
  return text.replace(TRAILING_SOURCES_RE, "");
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Parse the model's trailing Sources list into structured sources. */
export function parseTrailingSources(text: string, outlineUrl: string): Source[] {
  const match = text.match(TRAILING_SOURCES_RE);
  if (!match) return [];
  const base = outlineUrl.replace(/\/$/, "");
  const sources: Source[] = [];

  for (const line of match[0].split("\n")) {
    const urlMatch = line.match(/https?:\/\/[^\s)\]]+/);
    if (!urlMatch) continue;
    const url = urlMatch[0].replace(/[).,;:]+$/, "");
    const kind: Source["kind"] = url.startsWith(base) ? "kb" : "web";

    // Title = the line before the URL, minus markdown/list/label noise.
    // Markdown links ([title](url)) keep just the link text.
    let title = line.slice(0, line.indexOf(urlMatch[0]));
    const linkText = title.match(/\[([^\]]+)\]\($/);
    if (linkText) title = linkText[1];
    title = title
      .replace(/^[\s\-*•]+|\d+\.\s+/g, "")
      .replace(/\*\*/g, "")
      .replace(/\((?:web|kb|wiki)\)/gi, "")
      .replace(/^(?:kb|web|wiki)\s*[:—-]\s*/i, "")
      .replace(/[\s—–\-:(\[]+$/g, "")
      .trim();
    if (!title) title = kind === "web" ? hostnameOf(url) : url;

    sources.push({ title, url, kind });
  }
  return [...new Map(sources.map((s) => [s.url, s])).values()];
}

/** Merge source lists, first occurrence of a URL wins. */
export function mergeSources(...lists: Source[][]): Source[] {
  const merged = new Map<string, Source>();
  for (const list of lists) {
    for (const source of list) {
      if (!merged.has(source.url)) merged.set(source.url, source);
    }
  }
  return [...merged.values()];
}
