"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SyncButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "starting" | "running" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

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
      setMessage("Sync started — refresh to see progress.");
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

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={trigger}
        disabled={state === "starting" || state === "running"}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        {state === "running" ? "Syncing…" : "Re-sync now"}
      </button>
      {message && (
        <span className={`text-sm ${state === "error" ? "text-danger" : "text-muted"}`}>
          {message}
        </span>
      )}
    </div>
  );
}
