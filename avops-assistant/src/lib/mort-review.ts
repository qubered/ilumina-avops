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

export type MortMode = "off" | "shadow" | "live";
export type MortConfig = { mode: MortMode; threshold: number; envDefault: string };

export async function getMortConfig(): Promise<MortConfig> {
  const res = await fetch(`${base()}/mort/config`, {
    headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ingest /mort/config returned ${res.status}`);
  return (await res.json()) as MortConfig;
}

export type MortIdentity = { persona: string; scope: string; sourceOfTruth: string; safety: string };

/** Mort's canonical identity, owned by the ingest service. Null if unreachable. */
export async function getMortIdentity(): Promise<MortIdentity | null> {
  try {
    const res = await fetch(`${base()}/mort/identity`, {
      headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as MortIdentity;
  } catch {
    return null;
  }
}

export type MortMemoryResult = {
  journal: Array<{ ts: string; sourceId: string | null; mortId: string | null; action: string; rationale: string | null; confidence: number | null }>;
  files: Array<{ sourceId: string; role: string; folderOrigin: string | null; summary: string | null }>;
};

/** Read-only search of Mort's journal + corpus map. Empty on any failure. */
export async function searchMortMemory(query: string, limit = 12): Promise<MortMemoryResult> {
  try {
    const url = `${base()}/mort/memory?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` }, cache: "no-store" });
    if (!res.ok) return { journal: [], files: [] };
    return (await res.json()) as MortMemoryResult;
  } catch {
    return { journal: [], files: [] };
  }
}

export type MortHealth = {
  mode: MortMode;
  queue: { pending: number; running: number; dead: number };
  tokensToday: number;
  dailyTokenCap: number | null;
  capReached: boolean;
  deadJobs: Array<{ id: number; sourceId: string; attempts: number; lastError: string | null }>;
};

/** Ops health: queue depth, dead-letters, today's model spend. Null if unreachable. */
export async function getMortHealth(): Promise<MortHealth | null> {
  try {
    const res = await fetch(`${base()}/mort/health`, {
      headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as MortHealth;
  } catch {
    return null;
  }
}

export async function reviveJob(id: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${base()}/mort/jobs/revive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return { ok: res.ok };
}

export type MortActivityRow = {
  ts: string;
  sourceId: string | null;
  action: string;
  rationale: string | null;
  confidence: number | null;
  tokens: number | null;
  model: string | null;
  docTitle: string | null;
  outlineDocumentId: string | null;
};

export type MortLibraryRow = {
  sourceId: string;
  role: string;
  status: string;
  summary: string | null;
  zone: string[];
  system: string[];
  entities: string[];
  updatedAt: string;
  docCount: number;
  hasBytes: boolean;
};

export type MortActiveJob = {
  id: number;
  sourceId: string;
  fileName: string;
  status: string;
  attempts: number;
  runAfter: string;
  force: boolean;
  lastError: string | null;
};

export type MortActivity = {
  journal: MortActivityRow[];
  library: MortLibraryRow[];
  queue: MortActiveJob[];
};

/** What Mort has been doing, what's in flight, and everything he holds. Null if unreachable. */
export async function getMortActivity(query?: string): Promise<MortActivity | null> {
  try {
    const url = `${base()}/mort/activity${query ? `?q=${encodeURIComponent(query)}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` }, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as MortActivity;
  } catch {
    return null;
  }
}

export type MortFact = {
  id: number;
  factKey: string;
  value: string;
  scope: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceTier: string | null;
  approvedBy: string;
  confidence: string | null;
  note: string | null;
};

/** Human-approved current-state facts in force today. Empty on any failure. */
export async function listCurrentFacts(query?: string): Promise<MortFact[]> {
  try {
    const url = `${base()}/mort/facts${query ? `?q=${encodeURIComponent(query)}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` }, cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { facts: MortFact[] }).facts ?? [];
  } catch {
    return [];
  }
}

export async function createFact(
  fact: Omit<MortFact, "id" | "effectiveTo"> & { effectiveTo?: string | null },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${base()}/mort/facts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(fact),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export async function retireFact(id: number): Promise<{ ok: boolean }> {
  const res = await fetch(`${base()}/mort/facts/retire`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return { ok: res.ok };
}

export async function setMortMode(mode: MortMode): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${base()}/mort/config`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
