/**
 * Rate-limit handling for model calls. Free/shared tiers 429 constantly; the AI
 * SDK's own fast retries just burn attempts, so we honour the server's
 * Retry-After ourselves. Shared by the legacy normalise pipeline and Mort's
 * decision.
 */

const RATE_LIMIT_ATTEMPTS = 4;

/** Dig through the AI SDK error graph for a 429 and its Retry-After seconds. */
export function rateLimitInfo(err: unknown): { is429: boolean; retryAfterSec: number } {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length) {
    const e = stack.pop() as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const body = String((e as { responseBody?: unknown }).responseBody ?? "");
    if ((e as { statusCode?: number }).statusCode === 429 || /"code":\s*429|429/.test(body)) {
      const headers = (e as { responseHeaders?: Record<string, string> }).responseHeaders;
      const fromHeader = Number(headers?.["retry-after"]);
      let fromBody: number | undefined;
      try {
        fromBody = JSON.parse(body)?.error?.metadata?.retry_after_seconds;
      } catch {
        /* body not JSON */
      }
      const sec = [fromHeader, fromBody].find((v) => Number.isFinite(v) && (v as number) > 0);
      return { is429: true, retryAfterSec: (sec as number) ?? 15 };
    }
    for (const key of ["lastError", "cause"]) {
      if ((e as Record<string, unknown>)[key]) stack.push((e as Record<string, unknown>)[key]);
    }
    if (Array.isArray((e as { errors?: unknown[] }).errors)) {
      stack.push(...((e as { errors: unknown[] }).errors));
    }
  }
  return { is429: false, retryAfterSec: 0 };
}

/** Free models get transiently rate-limited; wait out the server's Retry-After. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const { is429, retryAfterSec } = rateLimitInfo(err);
      if (!is429 || attempt >= RATE_LIMIT_ATTEMPTS) throw err;
      const wait = Math.min(retryAfterSec + 2, 35);
      console.warn(`[ingest] rate-limited, waiting ${wait}s (attempt ${attempt}/${RATE_LIMIT_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}
