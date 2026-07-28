/**
 * Rate-limit handling moved into mort-core (v2/P6) — the agent loop makes the
 * same calls the pipeline does and needs the same Retry-After discipline. This
 * file stays as the ingest service's import point; call sites are unchanged.
 */
export { rateLimitInfo, withRateLimitRetry } from "@mort/core/model/ratelimit";
