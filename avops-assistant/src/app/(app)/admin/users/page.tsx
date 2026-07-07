import { desc, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { db, user } from "@/lib/db";
import { UserRow } from "@/components/user-row";

export const dynamic = "force-dynamic";

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeZone: "Australia/Sydney",
  }).format(d);
}

export default async function AdminUsersPage() {
  // Layout guards, but user management is sensitive enough to double-check.
  const session = await requireAdmin();
  if (!session) return null;

  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      banned: user.banned,
      createdAt: user.createdAt,
      // Fully qualified: drizzle renders bare column names in correlated
      // subqueries, and "id" would resolve to conversations.id (uuid).
      conversationCount: sql<number>`(
        select count(*) from "conversations"
        where "conversations"."user_id" = "user"."id"
      )::int`,
    })
    .from(user)
    .orderBy(desc(user.createdAt));

  const adminCount = rows.filter((u) => u.role === "admin" && !u.banned).length;

  return (
    <div className="pb-12">
      <section className="mt-6">
        <div className="flex items-baseline justify-between border-b border-divider pb-2">
          <h2 className="text-[15px] font-semibold text-text">
            Crew accounts ({rows.length})
          </h2>
          <p className="text-[13px] text-text-3">
            New accounts register themselves{" "}
            {process.env.SIGNUP_KEY ? "with the signup key" : "(open registration)"}
          </p>
        </div>
        <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-divider text-left text-[13px] text-text-3">
              <th className="py-1.5 pr-3 font-medium">Name</th>
              <th className="py-1.5 pr-3 font-medium">Role</th>
              <th className="py-1.5 pr-3 font-medium">Chats</th>
              <th className="py-1.5 pr-3 font-medium">Joined</th>
              <th className="py-1.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <UserRow
                key={u.id}
                userId={u.id}
                name={u.name}
                email={u.email}
                role={u.role ?? "member"}
                banned={Boolean(u.banned)}
                isSelf={u.id === session.user.id}
                isLastAdmin={u.role === "admin" && !u.banned && adminCount <= 1}
                conversationCount={u.conversationCount}
                joined={formatDate(u.createdAt)}
              />
            ))}
          </tbody>
        </table>
        </div>
        <p className="mt-3 text-[13px] text-text-3">
          Suspending blocks sign-in (and Outline SSO) but keeps the account and its
          history. Removing deletes the account and all of its conversations.
        </p>
      </section>
    </div>
  );
}
