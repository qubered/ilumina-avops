import { describe, expect, it } from "vitest";
import { digestWindow } from "./digest";

/**
 * The digest's window (MORT_V2_PLAN Part II).
 *
 * Only the window is tested here, and deliberately: the rest of `changeDigest`
 * is five queries against real tables, and a test that mocked `pool.query`
 * would assert the shape of the mock rather than the shape of the answer. The
 * window is the part that has to be right for the acceptance case — the chat
 * digest and the admin panel agreeing for the same period — because it is the
 * only thing the two callers pass in.
 */

const at = (iso: string) => new Date(iso);

describe("digestWindow", () => {
  it("spans exactly the days asked for, ending now", () => {
    const w = digestWindow(7, at("2026-07-28T09:00:00.000Z"));
    expect(w.days).toBe(7);
    expect(w.since).toBe("2026-07-21T09:00:00.000Z");
    expect(w.until).toBe("2026-07-28T09:00:00.000Z");
  });

  it("is stable for the same day count — two readers get the same period", () => {
    // This is the acceptance case in miniature: the panel and the tool both ask
    // for 7 days, so they must both be handed the same interval.
    const now = at("2026-07-28T09:00:00.000Z");
    expect(digestWindow(7, now)).toEqual(digestWindow(7, now));
  });

  it("is half-open, so adjacent windows never double-count a row", () => {
    const now = at("2026-07-28T00:00:00.000Z");
    const thisWeek = digestWindow(7, now);
    const lastWeek = digestWindow(7, at(thisWeek.since));
    // The boundary instant belongs to exactly one of them: it is `until` for
    // the older window (exclusive) and `since` for the newer (inclusive).
    expect(lastWeek.until).toBe(thisWeek.since);
  });

  it("defaults to a week", () => {
    expect(digestWindow(undefined, at("2026-07-28T00:00:00.000Z")).days).toBe(7);
  });

  it("clamps the range — a digest is a summary, not a report", () => {
    expect(digestWindow(0).days).toBe(1);
    expect(digestWindow(-5).days).toBe(1);
    expect(digestWindow(4000).days).toBe(90);
  });

  it("rounds a fractional day rather than producing a ragged window", () => {
    expect(digestWindow(1.4).days).toBe(1);
    expect(digestWindow(1.6).days).toBe(2);
  });
});
