import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyOutlineSignature } from "./webhook-verify";

const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({ event: "documents.update", payload: { id: "abc" } });

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("hex");
}

describe("verifyOutlineSignature", () => {
  it("accepts a valid t=,s= signature", () => {
    const ts = "1700000000";
    const header = `t=${ts},s=${sign(`${ts}.${BODY}`)}`;
    expect(verifyOutlineSignature(header, BODY, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = "1700000000";
    const header = `t=${ts},s=${sign(`${ts}.${BODY}`)}`;
    expect(verifyOutlineSignature(header, BODY + "x", SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const ts = "1700000000";
    const wrong = createHmac("sha256", "other").update(`${ts}.${BODY}`).digest("hex");
    expect(verifyOutlineSignature(`t=${ts},s=${wrong}`, BODY, SECRET)).toBe(false);
  });

  it("rejects a signature over a different timestamp", () => {
    const header = `t=999,s=${sign(`1700000000.${BODY}`)}`;
    expect(verifyOutlineSignature(header, BODY, SECRET)).toBe(false);
  });

  it("accepts a plain-body HMAC fallback", () => {
    expect(verifyOutlineSignature(sign(BODY), BODY, SECRET)).toBe(true);
  });

  it("rejects a wrong plain-body HMAC", () => {
    const wrong = createHmac("sha256", "other").update(BODY).digest("hex");
    expect(verifyOutlineSignature(wrong, BODY, SECRET)).toBe(false);
  });

  it("rejects a missing or garbage header", () => {
    expect(verifyOutlineSignature(null, BODY, SECRET)).toBe(false);
    expect(verifyOutlineSignature("", BODY, SECRET)).toBe(false);
    expect(verifyOutlineSignature("not-a-signature", BODY, SECRET)).toBe(false);
  });
});
