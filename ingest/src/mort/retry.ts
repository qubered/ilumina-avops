/** Retry policy for the durable job queue. Pure (no env / no DB) so it's testable. */

export const MAX_ATTEMPTS = 4;

/** Exponential backoff in minutes, capped so a poisoned job never schedules itself years out. */
export function backoffMinutes(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0), 60);
}
