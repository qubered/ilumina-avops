"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatProvenanceDate } from "@mort/core/memory/provenance";
import type { MortFact } from "@/lib/mort-admin";

/**
 * Current-state facts: deliberate, human-approved statements of what is true now.
 * These outrank the KB's documented standard in answers, so creating one is an
 * explicit act with your name on it.
 *
 * Every row wears its provenance (v2 P2): who taught it, when, and through
 * which door — with a link back to the conversation for anything taught in
 * chat. Re-declaring a key supersedes the old value rather than replacing it,
 * so "what was it before?" is a click away instead of gone.
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
    <section id="current-state" className="mt-10 scroll-mt-6">
      <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">Current state</h2>
      <p className="mt-2 text-[13px] text-text-3">
        Human-approved facts about what is true <em>now</em>. These outrank the KB&apos;s documented
        standard and the event log when Mort answers — so only add one you&apos;d stand behind.
        Re-using a key replaces its value and keeps the old one as history.
      </p>

      {facts.length === 0 ? (
        <p className="mt-3 text-sm text-text-3">No current-state facts.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {facts.map((f) => (
            <FactRow key={f.id} fact={f} busy={busy} onRetire={() => post({ retire: f.id })} />
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

const VIA_LABEL: Record<MortFact["taughtVia"], string> = {
  chat: "in chat",
  admin: "in the console",
  ingest: "from a file",
};

/** "who told me, when, where" — the whole point of P2, in one line. */
function Provenance({ fact }: { fact: MortFact }) {
  const when = formatProvenanceDate(fact.createdAt);
  return (
    <span className="text-[11px] text-text-3">
      {fact.approvedBy}
      {when && ` · ${when}`} · {VIA_LABEL[fact.taughtVia] ?? fact.taughtVia}
      {fact.taughtVia === "chat" && fact.conversationId && (
        <>
          {" · "}
          <a
            href={`/c/${fact.conversationId}${fact.messageId ? `#m-${fact.messageId}` : ""}`}
            className="underline decoration-divider underline-offset-2 hover:decoration-text-3"
          >
            source
          </a>
        </>
      )}
    </span>
  );
}

function FactRow({ fact, busy, onRetire }: { fact: MortFact; busy: boolean; onRetire: () => void }) {
  const [history, setHistory] = useState<MortFact[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadHistory() {
    if (history) return setHistory(null); // second click closes it
    setLoading(true);
    try {
      const params = new URLSearchParams({ factKey: fact.factKey });
      if (fact.scope) params.set("scope", fact.scope);
      const res = await fetch(`/api/admin/mort-facts?${params}`);
      const data = (await res.json()) as { history?: MortFact[] };
      setHistory((data.history ?? []).filter((h) => h.id !== fact.id));
    } catch {
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <li className="rounded-md border border-divider bg-menu px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-text">{fact.factKey}</span>
        <span className="text-accent">= {fact.value}</span>
        {fact.scope && <span className="text-xs text-text-3">({fact.scope})</span>}
        {fact.supersedes != null && (
          <span className="text-[11px] text-text-3" title={`Replaced fact #${fact.supersedes}`}>
            updated
          </span>
        )}
        <span className="ml-auto text-[11px] text-text-3">effective {fact.effectiveFrom ?? "—"}</span>
        <button
          onClick={loadHistory}
          disabled={loading}
          className="rounded border border-divider px-2 py-0.5 text-[11px] text-text-2 hover:bg-canvas-2 disabled:opacity-50"
        >
          {loading ? "…" : history ? "Hide history" : "History"}
        </button>
        <button
          onClick={onRetire}
          disabled={busy}
          className="rounded border border-divider px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-50"
        >
          Retire
        </button>
      </div>
      <div className="mt-1">
        <Provenance fact={fact} />
      </div>
      {history !== null &&
        (history.length === 0 ? (
          <p className="mt-2 border-t border-divider pt-2 text-[12px] text-text-3">
            No earlier value — this is the first thing Mort was told about {fact.factKey}.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 border-t border-divider pt-2">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2 text-[12px] text-text-2">
                <span className="text-text-3">was</span>
                <span>{h.value}</span>
                <span className="text-text-3">
                  {h.effectiveFrom ?? "—"} → {h.effectiveTo ?? "—"}
                </span>
                <Provenance fact={h} />
              </li>
            ))}
          </ul>
        ))}
    </li>
  );
}
