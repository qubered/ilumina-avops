"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SyncButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "starting" | "running" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function trigger() {
    setState("starting");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/sync", { method: "POST" });
      if (res.status === 409) {
        setState("running");
        setMessage("A sync is already running.");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState("running");
      setMessage("Sync started");
      // Refresh the page data a few times while the sync runs.
      let ticks = 0;
      const interval = setInterval(() => {
        router.refresh();
        if (++ticks >= 20) {
          clearInterval(interval);
          setState("idle");
        }
      }, 3000);
    } catch {
      setState("error");
      setMessage("Could not start the sync. Check the server logs.");
    }
  }

  // Two clicks, deliberately. Everything this drops is derived from Outline and
  // a re-sync rebuilds it, so it isn't dangerous — but it IS surprising next to
  // a button that only ever added things, and a stray click shouldn't empty the
  // KB the chat is answering from.
  async function reset() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setState("starting");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/kb-reset", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { docs?: number; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setState("idle");
      setMessage(`Index cleared — dropped ${json.docs ?? 0} document(s). Re-sync to rebuild.`);
      router.refresh();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Reset failed.");
    }
  }

  const busy = state === "starting" || state === "running";

  return (
    <div className="flex items-center gap-3">
      {message && (
        <span className={`text-[13px] ${state === "error" ? "text-danger" : "text-text-3"}`}>
          {message}
        </span>
      )}
      <button
        type="button"
        onClick={reset}
        onBlur={() => setConfirming(false)}
        disabled={busy}
        title="Drop every indexed document and start the index from nothing"
        className={`h-8 rounded border px-3 text-sm font-medium transition-colors duration-100 disabled:opacity-50 ${
          confirming
            ? "border-danger bg-danger/10 text-danger"
            : "border-divider text-text-3 hover:text-text"
        }`}
      >
        {confirming ? "Click again to clear" : "Clear index"}
      </button>
      <button
        type="button"
        onClick={trigger}
        disabled={busy}
        className="h-8 rounded bg-accent px-3 text-sm font-medium text-accent-fg transition-colors duration-100 hover:bg-accent-hover disabled:opacity-50"
      >
        {state === "running" ? "Syncing…" : "Re-sync now"}
      </button>
    </div>
  );
}
