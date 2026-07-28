"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MortConfig, MortMode } from "@/lib/mort-admin";

type Engine = MortConfig["engine"];

const ENGINES: { key: Engine; label: string; desc: string }[] = [
  {
    key: "pipeline",
    label: "Pipeline",
    desc: "The original fixed three passes: describe the file, pull up what's related, decide. Known behaviour.",
  },
  {
    key: "agent",
    label: "Agent",
    desc: "The same judgement made in one bounded agent turn, so Mort can go and read a second page before choosing. Run a parity comparison against your own corpus before switching.",
  },
];

const MODES: { key: MortMode; label: string; desc: string }[] = [
  { key: "off", label: "Off", desc: "Legacy one-file-one-article pipeline. Mort is dark." },
  { key: "shadow", label: "Shadow", desc: "Mort decides but only proposes — nothing is written until you approve." },
  { key: "live", label: "Live", desc: "Mort writes confident changes itself, no approval. Unsure ones still go to review." },
];

export function MortModeSwitcher({ config }: { config: MortConfig }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: { mode?: MortMode; chatWrites?: boolean; engine?: Engine }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/mort-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
                onClick={() => (m.key === config.mode ? undefined : post({ mode: m.key }))}
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

      <div className="mt-3 flex items-center gap-2 border-t border-divider pt-3">
        <span className="text-[13px] font-medium text-text">Chat writes</span>
        <button
          onClick={() => post({ chatWrites: !config.chatWrites })}
          disabled={busy}
          className={`ml-auto rounded-md border border-divider px-3 py-1 text-xs transition-colors disabled:opacity-50 ${
            config.chatWrites ? "bg-accent/15 font-semibold text-text" : "text-text-2 hover:text-text"
          }`}
        >
          {config.chatWrites ? "Enabled" : "Frozen"}
        </button>
      </div>
      <p className="mt-2 text-[12px] text-text-3">
        Whether crew can change the wiki from a conversation (corrections, new pages, brain dumps).
        Freezing this leaves questions and answers working exactly as they are. Shadow mode still turns
        every chat change into a review proposal, admins included.
      </p>

      <div className="mt-3 flex items-center gap-2 border-t border-divider pt-3">
        <span className="text-[13px] font-medium text-text">Ingestion engine</span>
        <div className="ml-auto inline-flex overflow-hidden rounded-md border border-divider">
          {ENGINES.map((e) => (
            <button
              key={e.key}
              onClick={() => (e.key === config.engine ? undefined : post({ engine: e.key }))}
              disabled={busy}
              className={`px-3 py-1 text-xs transition-colors ${
                config.engine === e.key
                  ? "bg-accent/15 font-semibold text-text"
                  : "text-text-2 hover:text-text disabled:opacity-50"
              }`}
            >
              {e.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[12px] text-text-3">{ENGINES.find((e) => e.key === config.engine)?.desc}</p>
      <p className="mt-1 text-[12px] text-text-3">
        Both engines obey the same gates — shadow mode, the confidence bar, and never touching a page Mort
        only guessed at. Compare them on your own files first with{" "}
        <code className="text-[11px]">pnpm --filter ingest parity -- --dir &lt;folder&gt;</code>.
      </p>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
