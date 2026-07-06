import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { Sidebar } from "@/components/sidebar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  if (!session) redirect("/login");

  return (
    <div className="flex h-full">
      <Sidebar
        user={{
          name: session.user.name,
          email: session.user.email,
          role: session.user.role ?? "member",
        }}
        outlineUrl={env.OUTLINE_URL}
      />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
