import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Outline's `outline-signature` webhook header (brief §6.3).
 *
 * Header format: `t=<unix ts>,s=<hex sig>`, where the signature is
 * HMAC-SHA256 over `<ts>.<body>`. A plain HMAC of the raw body is accepted
 * as a fallback. Timing-safe comparison throughout.
 */
export function verifyOutlineSignature(
  header: string | null,
  body: string,
  secret: string,
): boolean {
  if (!header) return false;

  const hmacHex = (payload: string) =>
    createHmac("sha256", secret).update(payload).digest("hex");

  const safeEqualHex = (a: string, b: string) => {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  };

  // `t=...,s=...` format
  const parts = Object.fromEntries(
    header
      .split(",")
      .map((part) => part.trim().split("=", 2) as [string, string])
      .filter(([k, v]) => k && v),
  ) as { t?: string; s?: string };

  if (parts.t && parts.s) {
    return safeEqualHex(hmacHex(`${parts.t}.${body}`), parts.s);
  }

  // Fallback: header is a bare HMAC of the body.
  if (/^[0-9a-f]{64}$/i.test(header.trim())) {
    return safeEqualHex(hmacHex(body), header.trim().toLowerCase());
  }

  return false;
}
