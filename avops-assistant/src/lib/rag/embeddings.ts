import { env } from "../env";

/**
 * Voyage AI REST client (brief §3): model voyage-3-large, 1024 dims,
 * input_type document/query.
 */

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const BATCH_SIZE = 96;
// Voyage's keyless free tier is limited to 3 requests/minute; retry 429s
// with ~20s spacing so a full sync completes instead of erroring per doc.
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 21_000;

async function postEmbeddings(batch: string[], inputType: "document" | "query") {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: batch,
        model: env.VOYAGE_MODEL,
        input_type: inputType,
      }),
    });
    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after")) * 1000;
      const delay = retryAfter > 0 ? retryAfter : RATE_LIMIT_DELAY_MS * (attempt + 1);
      console.warn(`[voyage] rate limited, retrying in ${Math.round(delay / 1000)}s`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    return res;
  }
}

export async function embedBatch(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await postEmbeddings(batch, inputType);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Voyage embeddings failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    const ordered = [...json.data].sort((a, b) => a.index - b.index);
    results.push(...ordered.map((d) => d.embedding));
  }

  return results;
}

export async function embedQuery(query: string): Promise<number[]> {
  const [vector] = await embedBatch([query], "query");
  return vector;
}
