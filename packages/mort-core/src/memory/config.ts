import { env } from "../env";
import { getNumericSetting, getSetting, setSetting } from "./settings";
import type { Channel } from "../tools/types";

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

/**
 * How many tool-calling steps a turn may take, per channel (MORT_V2_PLAN I.2,
 * v2 P4). Runtime-settable in `mort_settings` as `max_steps_<channel>`.
 *
 * The three numbers differ because the shapes of the turns differ. A chat turn
 * that teaches Mort something has to look the fact up, raise the card, then
 * answer — v1's 6 no longer fits. An ingest turn walks classify → understand →
 * gather → decide with retrieval in the middle. The dream is housekeeping and
 * should be the cheapest thing Mort does.
 *
 * The ceiling of 40 is a runaway guard, not a considered limit: this is the one
 * setting where a fat-fingered admin value costs real money.
 */
export const DEFAULT_MAX_STEPS: Record<Channel, number> = { chat: 10, ingest: 12, dream: 8 };

export async function getMaxSteps(channel: Channel): Promise<number> {
  return Math.round(await getNumericSetting(`max_steps_${channel}`, DEFAULT_MAX_STEPS[channel], { min: 1, max: 40 }));
}

export async function setMaxSteps(channel: Channel, steps: number): Promise<void> {
  await setSetting(`max_steps_${channel}`, String(Math.min(40, Math.max(1, Math.round(steps)))));
}
