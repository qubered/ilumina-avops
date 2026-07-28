import { after } from "next/server";
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from "resumable-stream";
import { env } from "./env";

let cached: ResumableStreamContext | null | undefined;

/**
 * Resumable-stream context backed by Redis pub/sub. Null when REDIS_URL is
 * unset — chat then falls back to poll-on-return (answers are still never
 * lost; they just don't resume token-by-token).
 */
export function getStreamContext(): ResumableStreamContext | null {
  if (cached !== undefined) return cached;
  if (!env.REDIS_URL) {
    cached = null;
    return cached;
  }
  // The package builds its node-redis clients from this env var.
  process.env.REDIS_URL = env.REDIS_URL;
  cached = createResumableStreamContext({ waitUntil: after });
  return cached;
}
