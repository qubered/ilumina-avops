/**
 * A minimal line diff for Mort's region — the before/after shown on a doc-edit
 * confirmation card (MORT_V2_PLAN Part II).
 *
 * Pure (strings in, rows out) so the card's contents are unit-testable without
 * Outline, a model, or a browser. This is not a general-purpose diff library:
 * mort regions are short, structured, and machine-written, so a plain LCS over
 * whole lines reads better here than a word-level patience diff would.
 */

export type DiffLine = { kind: "context" | "add" | "remove"; text: string };

const splitLines = (s: string): string[] => (s.length === 0 ? [] : s.replace(/\r\n/g, "\n").split("\n"));

/**
 * Longest-common-subsequence table over lines. Capped: past a few hundred lines
 * the O(n·m) table stops being free, and a region that big is better shown as a
 * wholesale replacement than as a line-by-line diff nobody will read.
 */
const MAX_LINES = 400;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ kind: "remove" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "remove", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "remove", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

/**
 * Drop long runs of unchanged lines, keeping `context` lines either side of
 * every change — the usual hunk view. A card showing eighty untouched metadata
 * lines around a one-line fix hides the fix.
 */
export function condenseDiff(lines: DiffLine[], context = 2): DiffLine[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((line, idx) => {
    if (line.kind === "context") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });

  const out: DiffLine[] = [];
  let skipping = false;
  lines.forEach((line, idx) => {
    if (keep[idx]) {
      out.push(line);
      skipping = false;
    } else if (!skipping) {
      out.push({ kind: "context", text: "…" });
      skipping = true;
    }
  });
  return out;
}

/** "+3 −1" style counts, for the one-line summary Mort speaks in chat. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number; changed: boolean } {
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "remove").length;
  return { added, removed, changed: added + removed > 0 };
}
