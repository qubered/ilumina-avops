import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unified spend rail (MORT_V2_PLAN Part IV).
 *
 * The bug this replaces is worth stating: v1's daily cap summed
 * `mort_journal.tokens`, and only the ingest worker and the dream ever wrote
 * that column — so every chat turn was free as far as the rail was concerned.
 * These tests are about the two properties that fixes: the cap sees every
 * channel, and it stops the autonomous ones without stopping a person waiting
 * on an answer.
 */

const ledger = vi.hoisted(() => [] as Array<{ channel: string; tokens: number; journalId: number | null }>);
const settings = vi.hoisted(() => ({} as Record<string, string>));
const envState = vi.hoisted(() => ({ cap: 0 }));

vi.mock("../env", () => ({ env: new Proxy({}, { get: () => envState.cap }) }));

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

// A ledger that behaves like the table: an insert carrying a journal_id that is
// already present is a no-op, which is what makes the backfill idempotent.
vi.mock("./db", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO mort_spend")) {
        const [channel, , , , tokens, journalId] = params as [string, string, string, string, number, number | null];
        if (journalId != null && ledger.some((r) => r.journalId === journalId)) return { rows: [], rowCount: 0 };
        ledger.push({ channel, tokens, journalId: journalId ?? null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("GROUP BY channel")) {
        const by = new Map<string, number>();
        for (const r of ledger) by.set(r.channel, (by.get(r.channel) ?? 0) + r.tokens);
        return { rows: [...by].map(([channel, n]) => ({ channel, n })) };
      }
      return { rows: [{ n: ledger.reduce((sum, r) => sum + r.tokens, 0) }] };
    },
  },
}));

const { getDailyTokenCap, recordSpend, spendRail, spendToday, spendTodayByChannel } = await import("./spend");

beforeEach(() => {
  ledger.length = 0;
  for (const k of Object.keys(settings)) delete settings[k];
  envState.cap = 0;
});

describe("the ledger", () => {
  it("counts every channel toward one total", async () => {
    await recordSpend({ channel: "chat", tokens: 1000 });
    await recordSpend({ channel: "ingest", tokens: 500 });
    await recordSpend({ channel: "dream", tokens: 250 });

    expect(await spendToday()).toBe(1750);
    expect(await spendTodayByChannel()).toEqual({ chat: 1000, ingest: 500, dream: 250 });
  });

  it("ignores a zero or nonsense reading rather than writing a junk row", async () => {
    await recordSpend({ channel: "chat", tokens: 0 });
    await recordSpend({ channel: "chat", tokens: Number.NaN });
    await recordSpend({ channel: "chat", tokens: -5 });
    expect(ledger).toHaveLength(0);
  });

  it("counts a journal-backed entry exactly once, however often it is replayed", async () => {
    // The backfill re-runs on every boot; a journal row must not buy Mort a
    // second budget each time the service restarts.
    await recordSpend({ channel: "ingest", tokens: 900, journalId: 42 });
    await recordSpend({ channel: "ingest", tokens: 900, journalId: 42 });
    expect(await spendToday()).toBe(900);
  });
});

describe("the cap", () => {
  it("falls back to the env default and lets a setting override it at runtime", async () => {
    envState.cap = 10_000;
    expect(await getDailyTokenCap()).toBe(10_000);
    settings.daily_token_cap = "50000";
    expect(await getDailyTokenCap()).toBe(50_000);
  });

  it("stops ingestion once the SHARED total is reached, not just ingestion's own", async () => {
    // The whole point of unifying the rail: a heavy day of chat is now a reason
    // the watch folder pauses, which it never was in v1.
    envState.cap = 1000;
    await recordSpend({ channel: "chat", tokens: 1200 });
    expect(await spendRail({ channel: "ingest" }).exceeded()).toBe(true);
    expect(await spendRail({ channel: "dream" }).exceeded()).toBe(true);
  });

  it("meters chat but never blocks it", async () => {
    // Cutting a crew member off mid-bump-in because the nightly dream was
    // expensive is a worse failure than the bill.
    envState.cap = 1000;
    await recordSpend({ channel: "dream", tokens: 5000 });
    const chat = spendRail({ channel: "chat" });
    expect(await chat.exceeded()).toBe(false);
    expect((await chat.status()).capReached).toBe(true);
  });

  it("never blocks anything when no cap is configured", async () => {
    await recordSpend({ channel: "ingest", tokens: 10_000_000 });
    expect(await spendRail({ channel: "ingest" }).exceeded()).toBe(false);
  });
});

describe("per-channel soft budgets", () => {
  it("reports a channel over its budget without stopping it", async () => {
    settings.budget_ingest = "1000";
    await recordSpend({ channel: "ingest", tokens: 1500 });

    const status = await spendRail({ channel: "ingest" }).status();
    expect(status.channel).toMatchObject({ name: "ingest", spent: 1500, budget: 1000, overBudget: true });
    // Soft: the hard cap is what stops work, and none is set here.
    expect(await spendRail({ channel: "ingest" }).exceeded()).toBe(false);
  });

  it("reports no budget when none is configured", async () => {
    const status = await spendRail({ channel: "chat" }).status();
    expect(status.channel.budget).toBeNull();
    expect(status.channel.overBudget).toBe(false);
  });
});
