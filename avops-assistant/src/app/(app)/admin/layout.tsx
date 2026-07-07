import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { AdminTabs } from "@/components/admin-tabs";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAdmin();
  if (!session) redirect("/");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[52rem] px-4 py-8 md:px-8 md:py-10">
        <h1 className="font-brand text-2xl font-semibold text-text">Admin</h1>
        <AdminTabs />
        {children}
      </div>
    </div>
  );
}
