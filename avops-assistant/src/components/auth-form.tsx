"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const inputClass =
  "w-full rounded-md border border-edge bg-bg px-3 py-2 text-fg placeholder-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20";

/**
 * Shared login/register form. On login, if the request arrived from an OIDC
 * authorize redirect (Outline SSO), better-auth resumes that flow
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
    <div className="flex min-h-full items-center justify-center bg-sidebar px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-xs font-semibold tracking-widest text-muted">
            ILUMINA AV OPS
          </div>
          <h1 className="mt-1 text-xl font-semibold text-fg">
            {mode === "login" ? "Sign in" : "Create your account"}
          </h1>
        </div>
        <form
          onSubmit={handleSubmit}
          className="space-y-3 rounded-lg border border-edge bg-bg p-6 shadow-sm"
        >
          {mode === "register" && (
            <div>
              <label htmlFor="name" className="mb-1 block text-sm font-medium">
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
            <label htmlFor="email" className="mb-1 block text-sm font-medium">
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
            <label htmlFor="password" className="mb-1 block text-sm font-medium">
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
              <label htmlFor="signupKey" className="mb-1 block text-sm font-medium">
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
            className="w-full rounded-md bg-accent px-3 py-2 font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? "Working..." : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-muted">
          {mode === "login" ? (
            <>
              No account?{" "}
              <Link href={otherHref} className="text-accent hover:underline">
                Register
              </Link>
            </>
          ) : (
            <>
              Already registered?{" "}
              <Link href={otherHref} className="text-accent hover:underline">
                Sign in
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
