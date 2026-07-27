"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MortHealth } from "@/lib/mort-review";

/** Ops surface: is the queue moving, is anything dead-lettered, what has Mort spent today. */
export function MortHealthPanel({ health }: { health: MortHealth }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);

  async function revive(id: number) {
    setBusy(id);
    try {
      await fetch("/api/admin/mort-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revive: id }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const { queue, tokensToday, dailyTokenCap, capReached, deadJobs } = health;

  return (
    <section className="mt-10">
      <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">Health</h2>

      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <Stat label="Queued" value={queue.pending} />
        <Stat label="Running" value={queue.running} />
        <Stat label="Dead-lettered" value={queue.dead} tone={queue.dead > 0 ? "danger" : undefined} />
        <Stat
          label="Tokens today"
          value={dailyTokenCap ? `${tokensToday.toLocaleString()} / ${dailyTokenCap.toLocaleString()}` : tokensToday.toLocaleString()}
          tone={capReached ? "danger" : undefined}
        />
      </div>

      {capReached && (
        <p className="mt-2 text-[12px] text-danger">
          Daily token cap reached — Mort has paused. Queued jobs resume tomorrow (or raise
          MORT_DAILY_TOKEN_CAP).
        </p>
      )}

      {deadJobs.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {deadJobs.map((j) => (
            <li key={j.id} className="rounded-md border border-divider bg-menu px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium text-text">{j.sourceId}</span>
                <span className="text-[11px] text-text-3">{j.attempts} attempts</span>
                <button
                  onClick={() => revive(j.id)}
                  disabled={busy === j.id}
                  className="ml-auto rounded border border-divider px-2 py-0.5 text-[11px] text-text-2 hover:text-text disabled:opacity-50"
                >
                  {busy === j.id ? "…" : "Retry"}
                </button>
              </div>
              {j.lastError && <p className="mt-1 line-clamp-2 text-[12px] text-danger">{j.lastError}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "danger" }) {
  return (
    <div className="rounded-md border border-divider bg-menu px-3 py-2">
      <div className="text-[11px] text-text-3">{label}</div>
      <div className={`text-[15px] font-semibold ${tone === "danger" ? "text-danger" : "text-text"}`}>{value}</div>
    </div>
  );
}
