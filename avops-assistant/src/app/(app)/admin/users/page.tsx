import { desc, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { db, user } from "@/lib/db";
import { UserActions } from "@/components/user-actions";

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
        <table className="mt-3 w-full text-sm">
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
              <tr key={u.id} className={`border-b border-divider ${u.banned ? "opacity-60" : ""}`}>
                <td className="py-2 pr-3">
                  <p className="font-medium text-text">
                    {u.name}
                    {u.id === session.user.id && (
                      <span className="ml-1.5 text-xs text-text-3">(you)</span>
                    )}
                  </p>
                  <p className="text-xs text-text-3">{u.email}</p>
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                      u.banned
                        ? "bg-danger/10 text-danger"
                        : u.role === "admin"
                          ? "bg-accent/10 text-link"
                          : "bg-canvas-2 text-text-2"
                    }`}
                  >
                    {u.banned ? "suspended" : (u.role ?? "member")}
                  </span>
                </td>
                <td className="py-2 pr-3 text-text-2">{u.conversationCount}</td>
                <td className="py-2 pr-3 text-text-2">{formatDate(u.createdAt)}</td>
                <td className="py-2 text-right">
                  <UserActions
                    userId={u.id}
                    role={u.role ?? "member"}
                    banned={Boolean(u.banned)}
                    isSelf={u.id === session.user.id}
                    isLastAdmin={u.role === "admin" && !u.banned && adminCount <= 1}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[13px] text-text-3">
          Suspending blocks sign-in (and Outline SSO) but keeps the account and its
          history. Removing deletes the account and all of its conversations.
        </p>
      </section>
    </div>
  );
}
