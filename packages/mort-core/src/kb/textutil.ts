/** Pure text helpers for Mort (no env / no I/O — unit-testable in isolation). */

/** Stable, URL-safe slug for a Mort doc id (paired with a registry-key hash for uniqueness). */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "doc"
  );
}

/** Read a `Key: value` line out of Mort's region body (blank-line separated). */
export function metaField(body: string, key: string): string | null {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "im").exec(body);
  return m ? m[1].trim() : null;
}
