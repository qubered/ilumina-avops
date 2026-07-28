import { createHash } from "node:crypto";

/**
 * Audit helpers for the tool harness (MORT_V2_PLAN I.3, decision V2-5).
 *
 * The journal records that a call happened and with what shape of arguments,
 * not the arguments themselves. Those live on the pending-action row the user
 * actually confirmed and expire with it; a journal that quietly accumulated
 * door codes and API tokens would be a worse liability than the audit trail is
 * an asset.
 */

/**
 * A stable digest of a call's arguments — enough to answer "is this the same
 * call as last time?" without storing what was in it.
 *
 * Keys are sorted before hashing so the answer doesn't depend on the order the
 * model happened to emit them in; without that, "same call" is never true twice.
 *
 * Takes `unknown` rather than an object because the universal audit (P4) hashes
 * whatever a tool was actually called with, and a no-argument tool is called
 * with nothing at all. `canonical` has always handled primitives; the narrower
 * signature only ever described the MCP case.
 */
export function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
