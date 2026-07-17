"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MortFact } from "@/lib/mort-review";

/**
 * Current-state facts: deliberate, human-approved statements of what is true now.
 * These outrank the KB's documented standard in answers, so creating one is an
 * explicit act with your name on it.
 */
export function MortFacts({ facts }: { facts: MortFact[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ factKey: "", value: "", scope: "", effectiveFrom: "", note: "" });

  async function post(body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/mort-facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Failed (${res.status})`);
      } else {
        setForm({ factKey: "", value: "", scope: "", effectiveFrom: "", note: "" });
        router.refresh();
      }
    } catch {
      setError("Request failed");
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded border border-divider bg-bg px-2 py-1 text-xs text-text placeholder:text-text-3";

  return (
    <section className="mt-10">
      <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">Current state</h2>
      <p className="mt-2 text-[13px] text-text-3">
        Human-approved facts about what is true <em>now</em>. These outrank the KB&apos;s documented
        standard and the event log when Mort answers — so only add one you&apos;d stand behind.
      </p>

      {facts.length === 0 ? (
        <p className="mt-3 text-sm text-text-3">No current-state facts.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {facts.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-md border border-divider bg-menu px-3 py-2 text-sm">
              <span className="font-medium text-text">{f.factKey}</span>
              <span className="text-accent">= {f.value}</span>
              {f.scope && <span className="text-xs text-text-3">({f.scope})</span>}
              <span className="ml-auto text-[11px] text-text-3">
                {f.effectiveFrom ?? "—"} · {f.approvedBy}
              </span>
              <button
                onClick={() => post({ retire: f.id })}
                disabled={busy}
                className="rounded border border-divider px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                Retire
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <input
          className={input}
          placeholder="fact key (led-wall-height)"
          value={form.factKey}
          onChange={(e) => setForm({ ...form, factKey: e.target.value })}
        />
        <input
          className={input}
          placeholder="value (2.5m)"
          value={form.value}
          onChange={(e) => setForm({ ...form, value: e.target.value })}
        />
        <input
          className={input}
          placeholder="scope (Main Stage)"
          value={form.scope}
          onChange={(e) => setForm({ ...form, scope: e.target.value })}
        />
        <input
          className={input}
          type="date"
          value={form.effectiveFrom}
          onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
        />
        <button
          onClick={() => post({ ...form, scope: form.scope || null, effectiveFrom: form.effectiveFrom || null, note: form.note || null })}
          disabled={busy || !form.factKey.trim() || !form.value.trim()}
          className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-success hover:bg-success/10 disabled:opacity-50"
        >
          {busy ? "…" : "Approve fact"}
        </button>
      </div>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </section>
  );
}
