import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  if (!session) redirect("/login");

  return (
    <AppShell
      user={{
        name: session.user.name,
        email: session.user.email,
        role: session.user.role ?? "member",
      }}
      outlineUrl={env.OUTLINE_URL}
    >
      {children}
    </AppShell>
  );
}
