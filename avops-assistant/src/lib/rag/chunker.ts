/**
 * Heading-aware markdown chunking (per build brief §6.2, ported from the
 * Python reference algorithm):
 *
 * - Split on `#`–`####` headings, tracking the heading path.
 * - Target ~500 tokens/chunk (4 chars/token heuristic).
 * - Oversized sections split on paragraph boundaries with a ~60-token tail
 *   overlap carried into the next piece.
 * - Tiny adjacent chunks are merged.
 * - Every chunk is prefixed with a breadcrumb line
 *   `[Doc title › Heading › Subheading]` so chunks are self-describing.
 */

export const TARGET_TOKENS = 500;
export const OVERLAP_TOKENS = 60;
export const MIN_TOKENS = 100;
const CHARS_PER_TOKEN = 4;

export type Chunk = {
  /** Chunk body including the breadcrumb prefix line. */
  text: string;
  breadcrumb: string;
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

type Section = {
  path: string[]; // heading path, e.g. ["Video", "E2 patching"]
  content: string;
};

const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const FENCE_RE = /^(```|~~~)/;

/** Split markdown into sections at #–#### headings, tracking heading paths. */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let path: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) sections.push({ path: [...path], content });
    buffer = [];
  };

  for (const line of markdown.split("\n")) {
    if (FENCE_RE.test(line.trim())) inFence = !inFence;
    const match = !inFence ? line.match(HEADING_RE) : null;
    if (match) {
      flush();
      const level = match[1].length; // 1-4
      const title = match[2].trim();
      path = [...path.slice(0, level - 1)];
      path[level - 1] = title;
      // Normalize holes left by skipped levels (e.g. # then ###).
      path = path.filter((p): p is string => Boolean(p));
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function breadcrumbFor(docTitle: string, path: string[]): string {
  return `[${[docTitle, ...path].join(" › ")}]`;
}

/** Tail of `text` roughly `tokens` long, cut at a word boundary. */
function tailOverlap(text: string, tokens: number): string {
  const chars = tokens * CHARS_PER_TOKEN;
  if (text.length <= chars) return text;
  const tail = text.slice(-chars);
  const firstSpace = tail.indexOf(" ");
  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
}

/** Split an oversized section body on paragraph boundaries with tail overlap. */
function splitOversized(content: string): string[] {
  const paragraphs = content.split(/\n{2,}/).filter((p) => p.trim());
  const pieces: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim()) pieces.push(current.trim());
  };

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (estimateTokens(candidate) > TARGET_TOKENS && current) {
      push();
      current = `${tailOverlap(current, OVERLAP_TOKENS)}\n\n${para}`;
    } else {
      current = candidate;
    }
  }
  push();

  // A single paragraph can still exceed the target (huge table/list): hard
  // split on lines as a fallback so no chunk is unboundedly large.
  return pieces.flatMap((piece) => {
    if (estimateTokens(piece) <= TARGET_TOKENS * 1.5) return [piece];
    const lines = piece.split("\n");
    const out: string[] = [];
    let cur = "";
    for (const line of lines) {
      const candidate = cur ? `${cur}\n${line}` : line;
      if (estimateTokens(candidate) > TARGET_TOKENS && cur) {
        out.push(cur);
        cur = line;
      } else {
        cur = candidate;
      }
    }
    if (cur.trim()) out.push(cur);
    return out;
  });
}

export function chunkMarkdown(docTitle: string, markdown: string): Chunk[] {
  const sections = splitSections(markdown);
  const raw: { breadcrumb: string; body: string }[] = [];

  for (const section of sections) {
    const breadcrumb = breadcrumbFor(docTitle, section.path);
    if (estimateTokens(section.content) > TARGET_TOKENS) {
      for (const piece of splitOversized(section.content)) {
        raw.push({ breadcrumb, body: piece });
      }
    } else {
      raw.push({ breadcrumb, body: section.content });
    }
  }

  // Merge tiny adjacent chunks (keeps the earlier chunk's breadcrumb).
  const merged: { breadcrumb: string; body: string }[] = [];
  for (const chunk of raw) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      estimateTokens(chunk.body) < MIN_TOKENS &&
      estimateTokens(`${prev.body}\n\n${chunk.body}`) <= TARGET_TOKENS
    ) {
      // Preserve the heading context of the absorbed section inline.
      const heading =
        chunk.breadcrumb !== prev.breadcrumb ? `${chunk.breadcrumb}\n` : "";
      prev.body = `${prev.body}\n\n${heading}${chunk.body}`;
    } else {
      merged.push({ ...chunk });
    }
  }

  return merged
    .filter((c) => c.body.trim())
    .map((c) => ({
      breadcrumb: c.breadcrumb,
      text: `${c.breadcrumb}\n${c.body}`,
    }));
}
