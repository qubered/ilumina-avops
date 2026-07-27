import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTEMPTS, backoffMinutes } from "./retry.js";

test("backoff grows exponentially and is capped", () => {
  assert.equal(backoffMinutes(1), 1);
  assert.equal(backoffMinutes(2), 2);
  assert.equal(backoffMinutes(3), 4);
  assert.equal(backoffMinutes(4), 8);
  // Capped so a poisoned job never schedules itself years out.
  assert.equal(backoffMinutes(20), 60);
  // Defensive: attempt 0 must not produce a fractional/negative delay.
  assert.equal(backoffMinutes(0), 1);
});

test("MAX_ATTEMPTS is a sane dead-letter threshold", () => {
  assert.ok(MAX_ATTEMPTS >= 2 && MAX_ATTEMPTS <= 10);
});
