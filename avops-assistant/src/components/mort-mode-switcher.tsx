"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MortConfig, MortMode } from "@/lib/mort-review";

const MODES: { key: MortMode; label: string; desc: string }[] = [
  { key: "off", label: "Off", desc: "Legacy one-file-one-article pipeline. Mort is dark." },
  { key: "shadow", label: "Shadow", desc: "Mort decides but only proposes — nothing is written until you approve." },
  { key: "live", label: "Live", desc: "Mort writes confident changes itself, no approval. Unsure ones still go to review." },
];

export function MortModeSwitcher({ config }: { config: MortConfig }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function set(next: MortMode) {
    if (next === config.mode || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/mort-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
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
      setBusy(false);
    }
  }

  const current = MODES.find((m) => m.key === config.mode);

  return (
    <div className="mt-4 rounded-md border border-divider bg-menu px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-text">Authoring mode</span>
        <div className="ml-auto inline-flex overflow-hidden rounded-md border border-divider">
          {MODES.map((m) => {
            const active = config.mode === m.key;
            return (
              <button
                key={m.key}
                onClick={() => set(m.key)}
                disabled={busy}
                className={`px-3 py-1 text-xs transition-colors ${
                  active
                    ? m.key === "live"
                      ? "bg-danger/15 font-semibold text-danger"
                      : "bg-accent/15 font-semibold text-text"
                    : "text-text-2 hover:text-text disabled:opacity-50"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-[12px] text-text-3">{current?.desc}</p>
      <p className="mt-1 text-[12px] text-text-3">
        Unsure decisions (confidence &lt; {config.threshold}) always go to review, and Mort only ever
        edits its own region — non-destructive in every mode.
      </p>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
