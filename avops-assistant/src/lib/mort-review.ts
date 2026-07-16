import { env } from "./env";

/**
 * Server-side client for the Mort ingest review API. The ingest service owns the
 * review queue (it has the Outline write deps); the assistant is just the UI, so
 * these run only on the server with INTERNAL_API_KEY.
 */

export type MortReviewItem = {
  id: number;
  action: string;
  source_id: string | null;
  target_doc_id: string | null;
  payload: { title?: string; collection?: string | null; regionBody?: string } | null;
  rationale: string | null;
  created_at: string;
};

const base = () => env.INGEST_INTERNAL_URL.replace(/\/$/, "");

export async function listPendingReviews(): Promise<MortReviewItem[]> {
  const res = await fetch(`${base()}/review`, {
    headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ingest /review returned ${res.status}`);
  const json = (await res.json()) as { items: MortReviewItem[] };
  return json.items ?? [];
}

export async function decideReview(
  id: number,
  decision: "approve" | "reject",
  decidedBy?: string,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${base()}/review/decision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id, decision, decidedBy }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
