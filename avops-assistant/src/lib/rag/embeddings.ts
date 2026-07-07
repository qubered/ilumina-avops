import { env } from "../env";

/**
 * Embeddings, provider-selectable via EMBEDDINGS_PROVIDER:
 *
 *  - "ollama" (default): a local model served by Ollama — free, private,
 *    no rate limits. Default model nomic-embed-text (768d), which wants
 *    task prefixes (search_document/search_query) for best retrieval.
 *  - "voyage": the Voyage AI REST API (voyage-3-large, 1024d). Keyless
 *    tier is limited to 3 requests/minute, hence the 429 backoff.
 *
 * Vector dimensions differ per model, so the Qdrant collection size is
 * probed at runtime (embeddingDim) and recreated on mismatch — switching
 * models requires a full re-sync, which the admin page can trigger.
 */

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const BATCH_SIZE = 96;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 21_000;

type InputType = "document" | "query";

/** Task prefixes some local models need for asymmetric retrieval. */
function prefixFor(model: string, inputType: InputType): string {
  if (model.includes("nomic")) {
    return inputType === "document" ? "search_document: " : "search_query: ";
  }
  if (model.includes("mxbai") && inputType === "query") {
    return "Represent this sentence for searching relevant passages: ";
  }
  return "";
}

async function ollamaEmbed(texts: string[], inputType: InputType): Promise<number[][]> {
  const prefix = prefixFor(env.EMBEDDINGS_MODEL, inputType);
  const res = await fetch(`${env.OLLAMA_URL.replace(/\/$/, "")}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.EMBEDDINGS_MODEL,
      input: texts.map((t) => prefix + t),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Ollama embeddings failed (${res.status}): ${text.slice(0, 300)} — is the model pulled? (ollama pull ${env.EMBEDDINGS_MODEL})`,
    );
  }
  const json = (await res.json()) as { embeddings: number[][] };
  if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) {
    throw new Error("Ollama embeddings returned an unexpected shape");
  }
  return json.embeddings;
}

async function voyagePost(batch: string[], inputType: InputType) {
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

async function voyageEmbed(texts: string[], inputType: InputType): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await voyagePost(batch, inputType);
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

export async function embedBatch(
  texts: string[],
  inputType: InputType,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  return env.EMBEDDINGS_PROVIDER === "ollama"
    ? ollamaEmbed(texts, inputType)
    : voyageEmbed(texts, inputType);
}

export async function embedQuery(query: string): Promise<number[]> {
  const [vector] = await embedBatch([query], "query");
  return vector;
}

let cachedDim: number | null = null;

/** The active model's vector size, probed once per process. */
export async function embeddingDim(): Promise<number> {
  if (cachedDim === null) {
    const [probe] = await embedBatch(["dimension probe"], "query");
    cachedDim = probe.length;
  }
  return cachedDim;
}
