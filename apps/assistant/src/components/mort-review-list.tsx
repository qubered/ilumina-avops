"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DREAM_LABEL,
  isDreamProposal,
  reviewActionable as actionable,
  whyNotActionable,
} from "@mort/core/kb/review-shape";
import type { MortReviewItem } from "@/lib/mort-admin";

/**
 * "Can this be approved, and if not why" now comes from core (v2 P8), because
 * an admin can also triage this queue from a conversation — and two copies of
 * that judgement is how the console and the chat start describing the same
 * proposal differently.
 */

const ACTION_COLOR: Record<string, string> = {
  CREATE: "text-success",
  UPDATE_ADDITIVE: "text-accent",
  ATTACH: "text-text-2",
  REVIEW: "text-text-2",
  tombstone: "text-danger",
};

const APPROVE_LABEL: Record<string, string> = {
  CREATE: "Approve & write",
  UPDATE_ADDITIVE: "Approve & write",
  ATTACH: "Approve & attach",
  tombstone: "Approve removal",
};

const isDream = isDreamProposal;

export function MortReviewList({ items }: { items: MortReviewItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: number, decision: "approve" | "reject") {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/admin/mort-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setError("Request failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <ul className="mt-4 space-y-2">
        {items.map((item) => (
          <li key={item.id} className="rounded-md border border-divider bg-menu px-3 py-2.5 text-sm">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold ${isDream(item.action) ? "text-accent" : ACTION_COLOR[item.action] ?? "text-text-2"}`}>
                {isDream(item.action) ? DREAM_LABEL[item.action] ?? "Noticed" : item.action}
              </span>
              <span className="font-medium text-text">{item.payload?.title ?? item.source_id ?? "—"}</span>
              {item.payload?.collection && <span className="text-xs text-text-3">→ {item.payload.collection}</span>}
            </div>
            {!isDream(item.action) && item.source_id && (
              <p className="mt-0.5 text-[12px] text-text-3">{item.source_id}</p>
            )}
            {item.rationale && <p className="mt-1 text-text-2">{item.rationale}</p>}
            <div className="mt-2 flex items-center gap-2">
              {actionable(item) ? (
                <button
                  onClick={() => decide(item.id, "approve")}
                  disabled={busy === item.id}
                  className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-success hover:bg-success/10 disabled:opacity-50"
                >
                  {busy === item.id ? "…" : APPROVE_LABEL[item.action] ?? "Approve"}
                </button>
              ) : (
                <span className="text-[11px] text-text-3">{whyNotActionable(item)}</span>
              )}
              <button
                onClick={() => decide(item.id, "reject")}
                disabled={busy === item.id}
                className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                {actionable(item) ? "Reject" : "Dismiss"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
