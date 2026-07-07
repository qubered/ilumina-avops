import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { SettingsForm } from "@/components/settings-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings — ILUMINA AV Ops" };

export default async function SettingsPage() {
  const session = await requireSession();
  if (!session) redirect("/login");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[52rem] px-4 py-8 md:px-8 md:py-10">
        <h1 className="font-brand text-2xl font-semibold text-text">Settings</h1>
        <div className="mt-6">
          <SettingsForm initialName={session.user.name} email={session.user.email} />
        </div>
      </div>
    </div>
  );
}
