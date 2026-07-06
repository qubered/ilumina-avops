import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";

export const metadata = { title: "Register — ILUMINA AV Ops" };

export default function RegisterPage() {
  return (
    <Suspense>
      <AuthForm mode="register" />
    </Suspense>
  );
}
