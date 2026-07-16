"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MortReviewItem } from "@/lib/mort-review";

const ACTION_COLOR: Record<string, string> = {
  CREATE: "text-success",
  UPDATE_ADDITIVE: "text-accent",
  ATTACH: "text-text-2",
  REVIEW: "text-text-2",
};

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
              <span className={`text-xs font-semibold ${ACTION_COLOR[item.action] ?? "text-text-2"}`}>{item.action}</span>
              <span className="font-medium text-text">{item.payload?.title ?? item.source_id ?? "—"}</span>
              {item.payload?.collection && <span className="text-xs text-text-3">→ {item.payload.collection}</span>}
            </div>
            {item.source_id && <p className="mt-0.5 text-[12px] text-text-3">{item.source_id}</p>}
            {item.rationale && <p className="mt-1 text-text-2">{item.rationale}</p>}
            <div className="mt-2 flex items-center gap-2">
              {item.action === "CREATE" || item.action === "UPDATE_ADDITIVE" ? (
                <button
                  onClick={() => decide(item.id, "approve")}
                  disabled={busy === item.id}
                  className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-success hover:bg-success/10 disabled:opacity-50"
                >
                  {busy === item.id ? "…" : "Approve & write"}
                </button>
              ) : (
                <span className="text-[11px] text-text-3">
                  {item.action === "ATTACH" ? "attach not wired yet — reject or handle manually" : "flagged for a human — no auto-action"}
                </span>
              )}
              <button
                onClick={() => decide(item.id, "reject")}
                disabled={busy === item.id}
                className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                {item.action === "CREATE" || item.action === "UPDATE_ADDITIVE" ? "Reject" : "Dismiss"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
