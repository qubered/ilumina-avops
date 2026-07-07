"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/** Compact login shown when the widget iframe has no session. */
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
    "h-8 w-full rounded border border-input-border bg-input px-2.5 text-base text-text outline-none transition-colors duration-100 focus:border-input-focus md:text-sm";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas px-6">
      <div className="text-center">
        <span className="mx-auto mb-2 flex size-8 items-center justify-center rounded-md bg-accent font-brand text-sm font-semibold text-accent-fg">
          I
        </span>
        <p className="font-brand text-base font-semibold text-text">
          ILUMINA AV Ops
        </p>
        <p className="text-[13px] text-text-2">Sign in to ask the crew knowledge base</p>
      </div>
      <form onSubmit={handleSubmit} className="w-full max-w-[240px] space-y-2">
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
          className="h-8 w-full rounded bg-accent text-sm font-medium text-accent-fg transition-colors duration-100 hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Continue"}
        </button>
      </form>
      <a
        href={appUrl}
        target="_blank"
        rel="noreferrer"
        className="text-xs text-link hover:underline"
      >
        Open the full app ↗
      </a>
    </div>
  );
}
