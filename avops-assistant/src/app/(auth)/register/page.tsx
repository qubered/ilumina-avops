import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";
import { getEnv } from "@/lib/env";

export const metadata = { title: "Register — ILUMINA AV Ops" };
export const dynamic = "force-dynamic"; // reads env at request time

export default function RegisterPage() {
  const requiresSignupKey = Boolean(getEnv().SIGNUP_KEY);
  return (
    <Suspense>
      <AuthForm mode="register" requiresSignupKey={requiresSignupKey} />
    </Suspense>
  );
}
