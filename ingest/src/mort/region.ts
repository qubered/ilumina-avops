/**
 * Non-destructive region splicing (MORT v1.4).
 *
 * Mort only ever writes inside his own region, fenced by HTML comment markers
 * that Outline preserves through its ProseMirror round-trip (verified by
 * scripts/outline-roundtrip-probe.ts, 2026-07-16). Everything OUTSIDE the
 * markers is human content and is passed through byte-for-byte as read from
 * Outline — so re-normalisation on save is idempotent and Mort can never remove
 * or rewrite a human's words.
 *
 * These functions are pure (string in, string out) so they are exhaustively
 * unit-testable without a live Outline.
 */

export const MORT_START = "<!-- mort:start -->";
export const MORT_END = "<!-- mort:end -->";

/** Indexes of a single well-formed region, or null if there isn't one. */
function regionBounds(text: string): { start: number; end: number } | null {
  const start = text.indexOf(MORT_START);
  if (start === -1) return null;
  const end = text.indexOf(MORT_END, start + MORT_START.length);
  if (end === -1) return null;
  return { start, end };
}

/** True if the text contains exactly one well-formed Mort region. */
export function hasMortRegion(text: string): boolean {
  return regionBounds(text) !== null;
}

/**
 * A malformed region — a start with no following end, or an end with no start.
 * The writer must NOT auto-edit these (it can't tell where Mort's content is);
 * route to review instead of risking corruption.
 */
export function isMalformedRegion(text: string): boolean {
  const hasStart = text.includes(MORT_START);
  const hasEnd = text.includes(MORT_END);
  if (!hasStart && !hasEnd) return false; // no region at all is fine (we append)
  return regionBounds(text) === null; // one marker present but not a valid pair
}

/** The current content between Mort's markers (trimmed), or null if none. */
export function extractMortRegion(text: string): string | null {
  const b = regionBounds(text);
  if (!b) return null;
  return text.slice(b.start + MORT_START.length, b.end).trim();
}

/**
 * Return `currentText` with Mort's region set to `mortBody`, preserving every
 * byte of human content outside the markers. If there is no region yet, append
 * one after the existing content. Throws on a malformed region (caller should
 * have checked isMalformedRegion and routed to review).
 */
export function spliceMortRegion(currentText: string, mortBody: string): string {
  if (isMalformedRegion(currentText)) {
    throw new Error("refusing to splice: document has a malformed Mort region (stray marker)");
  }
  const block = `${MORT_START}\n\n${mortBody.trim()}\n\n${MORT_END}`;
  const b = regionBounds(currentText);
  if (b) {
    const before = currentText.slice(0, b.start);
    const after = currentText.slice(b.end + MORT_END.length);
    return `${before}${block}${after}`;
  }
  const base = currentText.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}
