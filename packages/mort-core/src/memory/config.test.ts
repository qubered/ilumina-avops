import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-channel step caps (MORT_V2_PLAN I.2, v2 P4).
 *
 * The three channels have genuinely different shapes — a teaching chat turn
 * looks the fact up, raises a card and then answers; an ingest turn walks
 * classify → understand → gather → decide — so one MAX_STEPS constant was
 * always going to be wrong for two of them. What's under test here is that the
 * runtime override exists and that a bad value can't cost real money.
 */

const settings = vi.hoisted(() => ({} as Record<string, string>));

vi.mock("../env", () => ({ env: { MORT_MODE: "off", MORT_CONFIDENCE_THRESHOLD: 0.6 } }));
vi.mock("./settings", () => ({
  getSetting: async (key: string) => settings[key] ?? null,
  setSetting: async (key: string, value: string) => {
    settings[key] = value;
  },
  getNumericSetting: async (key: string, fallback: number, bounds: { min?: number; max?: number } = {}) => {
    const raw = settings[key];
    const n = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(bounds.max ?? Infinity, Math.max(bounds.min ?? -Infinity, n));
  },
}));

const { DEFAULT_MAX_STEPS, getMaxSteps, setMaxSteps } = await import("./config");

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
});

describe("getMaxSteps", () => {
  it("defaults to the plan's per-channel numbers", async () => {
    expect(DEFAULT_MAX_STEPS).toEqual({ chat: 10, ingest: 12, dream: 8 });
    expect(await getMaxSteps("chat")).toBe(10);
    expect(await getMaxSteps("ingest")).toBe(12);
    expect(await getMaxSteps("dream")).toBe(8);
  });

  it("takes a per-channel override from mort_settings", async () => {
    await setMaxSteps("chat", 15);
    expect(settings.max_steps_chat).toBe("15");
    expect(await getMaxSteps("chat")).toBe(15);
    // One channel's override is exactly that.
    expect(await getMaxSteps("ingest")).toBe(12);
  });

  it("clamps a fat-fingered value rather than acting on it", async () => {
    await setMaxSteps("ingest", 5000);
    expect(await getMaxSteps("ingest")).toBe(40);
    await setMaxSteps("ingest", 0);
    expect(await getMaxSteps("ingest")).toBe(1);
  });

  it("falls back to the default when the stored value is junk", async () => {
    settings.max_steps_dream = "lots";
    expect(await getMaxSteps("dream")).toBe(8);
  });
});
