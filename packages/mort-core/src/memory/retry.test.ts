import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, backoffMinutes } from "./retry";

describe("retry policy", () => {
  it("backoff grows exponentially and is capped", () => {
    expect(backoffMinutes(1)).toBe(1);
    expect(backoffMinutes(2)).toBe(2);
    expect(backoffMinutes(3)).toBe(4);
    expect(backoffMinutes(4)).toBe(8);
    // Capped so a poisoned job never schedules itself years out.
    expect(backoffMinutes(20)).toBe(60);
    // Defensive: attempt 0 must not produce a fractional/negative delay.
    expect(backoffMinutes(0)).toBe(1);
  });

  it("MAX_ATTEMPTS is a sane dead-letter threshold", () => {
    expect(MAX_ATTEMPTS >= 2 && MAX_ATTEMPTS <= 10).toBe(true);
  });
});
