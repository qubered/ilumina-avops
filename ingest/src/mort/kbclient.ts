import { env } from "../env.js";

/**
 * Client for the assistant's internal KB search (MORT_PLAN §v1.5). Mort reads
 * the KB through the assistant (single Qdrant owner) over the compose network.
 *
 * Graceful degradation: any failure returns [] and logs — Mort then decides
 * with no KB context rather than the whole ingest turn dying.
 */

export type KbHit = {
  docId: string;
  title: string;
  url: string;
  breadcrumb: string;
  score: number;
  text: string;
  zone?: string[];
  system?: string[];
  docType?: string[];
};

export async function kbSearch(query: string, limit = 5): Promise<KbHit[]> {
  if (!env.ASSISTANT_KB_URL) return []; // not configured → no KB context
  try {
    const res = await fetch(env.ASSISTANT_KB_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.INTERNAL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error(`[kb-search] assistant returned ${res.status}`);
      return [];
    }
    const json = (await res.json()) as { hits?: KbHit[] };
    return json.hits ?? [];
  } catch (err) {
    console.error("[kb-search] assistant unreachable:", err);
    return [];
  }
}
