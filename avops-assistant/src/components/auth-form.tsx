"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const inputClass =
  "h-9 w-full rounded border border-input-border bg-input px-3 text-[15px] text-text outline-none transition-colors duration-100 focus:border-input-focus";
const labelClass = "mb-1 block text-sm font-medium text-text-2";

/**
 * Shared login/register form, set like Outline's login: a quiet centered
 * column on the canvas, no card. On login, if the request arrived from an
 * OIDC authorize redirect (Outline SSO), better-auth resumes that flow
 * automatically after sign-in.
 */
export function AuthForm({
  mode,
  requiresSignupKey = false,
}: {
  mode: "login" | "register";
  requiresSignupKey?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupKey, setSignupKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Preserve OIDC authorize params across the login/register link hop.
  const query = searchParams.toString();
  const otherHref = (mode === "login" ? "/register" : "/login") + (query ? `?${query}` : "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "register") {
        const { error: signUpError } = await authClient.signUp.email({
          name,
          email,
          password,
          fetchOptions: signupKey
            ? { headers: { "x-signup-key": signupKey } }
            : undefined,
        });
        if (signUpError) {
          setError(signUpError.message ?? "Registration failed.");
          return;
        }
      }
      const { data, error: signInError } = await authClient.signIn.email({
        email,
        password,
      });
      if (signInError) {
        setError(signInError.message ?? "Sign in failed.");
        return;
      }
      // When this login is part of an OIDC authorize flow (Outline SSO),
      // better-auth replies with a redirect target back to the client app.
      const redirect = data as { redirect?: boolean; url?: string } | null;
      if (redirect?.redirect && redirect.url) {
        window.location.assign(redirect.url);
        return;
      }
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-xs">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-3 flex size-9 items-center justify-center rounded-md bg-accent text-[15px] font-semibold text-accent-fg">
            I
          </span>
          <h1 className="text-2xl font-semibold text-text">
            {mode === "login" ? "Login to AV Ops" : "Create your account"}
          </h1>
          <p className="mt-1 text-sm text-text-2">
            The ILUMINA crew knowledge assistant
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "register" && (
            <div>
              <label htmlFor="name" className={labelClass}>
                Name
              </label>
              <input
                id="name"
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
          )}
          <div>
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input
              id="email"
              type="email"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div>
            <label htmlFor="password" className={labelClass}>
              Password
            </label>
            <input
              id="password"
              type="password"
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>
          {mode === "register" && requiresSignupKey && (
            <div>
              <label htmlFor="signupKey" className={labelClass}>
                Signup key
              </label>
              <input
                id="signupKey"
                type="password"
                className={inputClass}
                value={signupKey}
                onChange={(e) => setSignupKey(e.target.value)}
                required
                autoComplete="off"
                placeholder="Crew invite code"
              />
            </div>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="h-9 w-full rounded bg-accent text-sm font-medium text-accent-fg transition-colors duration-100 hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Working…" : mode === "login" ? "Continue" : "Create account"}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-text-2">
          {mode === "login" ? (
            <>
              No account?{" "}
              <Link href={otherHref} className="text-link hover:underline">
                Register
              </Link>
            </>
          ) : (
            <>
              Already registered?{" "}
              <Link href={otherHref} className="text-link hover:underline">
                Sign in
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
