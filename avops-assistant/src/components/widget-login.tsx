"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/** Compact login shown when the widget iframe has no session (brief §9). */
export function WidgetLogin({ appUrl }: { appUrl: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { error: signInError } = await authClient.signIn.email({ email, password });
      if (signInError) {
        setError(signInError.message ?? "Sign in failed.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-edge bg-bg px-2.5 py-1.5 text-sm text-fg placeholder-faint outline-none focus:border-accent";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg px-6">
      <div className="text-center">
        <p className="text-xs font-semibold tracking-widest text-muted">ILUMINA AV OPS</p>
        <p className="mt-1 text-sm text-muted">Sign in to ask the KB</p>
      </div>
      <form onSubmit={handleSubmit} className="w-full max-w-[260px] space-y-2">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className={inputClass}
          autoComplete="email"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className={inputClass}
          autoComplete="current-password"
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <a
        href={appUrl}
        target="_blank"
        rel="noreferrer"
        className="text-xs text-accent hover:underline"
      >
        Open full app ↗
      </a>
    </div>
  );
}
