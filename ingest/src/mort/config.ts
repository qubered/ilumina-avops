import { env } from "../env.js";
import { getSetting, setSetting } from "./memory.js";

/**
 * Effective Mort authoring mode = the runtime setting (admin UI) if set,
 * otherwise the env default. Lets an admin flip off ↔ shadow ↔ live without a
 * redeploy. Non-destructiveness holds in every mode; the mode only controls
 * whether Mort proposes (shadow) or writes confident changes itself (live).
 */

export type MortMode = "off" | "shadow" | "live";
const MODES: MortMode[] = ["off", "shadow", "live"];

export function isMode(v: unknown): v is MortMode {
  return typeof v === "string" && (MODES as string[]).includes(v);
}

export async function getEffectiveMode(): Promise<MortMode> {
  const v = await getSetting("mode");
  return isMode(v) ? v : env.MORT_MODE;
}

export async function setMode(mode: MortMode): Promise<void> {
  await setSetting("mode", mode);
}

export async function getEffectiveThreshold(): Promise<number> {
  const v = await getSetting("confidence_threshold");
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : env.MORT_CONFIDENCE_THRESHOLD;
}
