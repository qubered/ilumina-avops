import { redirect } from "next/navigation";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { db, feedback, kbDocuments, messages, syncRuns, user } from "@/lib/db";

export const dynamic = "force-dynamic";

import { SyncButton } from "@/components/sync-button";

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  }).format(d);
}

export default async function AdminPage() {
  const session = await requireAdmin();
  if (!session) redirect("/");

  const [runs, docs, docStats, recentFeedback, unanswered] = await Promise.all([
    db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(10),
    db.select().from(kbDocuments).orderBy(desc(kbDocuments.syncedAt)),
    db
      .select({
        docCount: sql<number>`count(*)::int`,
        chunkCount: sql<number>`coalesce(sum(${kbDocuments.chunkCount}), 0)::int`,
        errorCount: sql<number>`count(*) filter (where ${kbDocuments.status} = 'error')::int`,
      })
      .from(kbDocuments),
    db
      .select({
        id: feedback.id,
        rating: feedback.rating,
        comment: feedback.comment,
        createdAt: feedback.createdAt,
        userName: user.name,
        answer: messages.content,
        conversationId: messages.conversationId,
      })
      .from(feedback)
      .innerJoin(messages, eq(feedback.messageId, messages.id))
      .innerJoin(user, eq(feedback.userId, user.id))
      .orderBy(desc(feedback.createdAt))
      .limit(50),
    // Heuristic KB-gap list: assistant answers that say the KB doesn't cover it.
    db
      .select({
        id: messages.id,
        content: messages.content,
        createdAt: messages.createdAt,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(
        or(
          ilike(messages.content, "%does not cover%"),
          ilike(messages.content, "%doesn't cover%"),
          ilike(messages.content, "%not covered in the knowledge base%"),
          ilike(messages.content, "%no information in the knowledge base%"),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(20),
  ]);

  const stats = docStats[0];
  const lastSuccess = runs.find((r) => r.status === "success");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[52rem] px-6 py-8">
        <h1 className="text-xl font-semibold">Admin</h1>

        {/* KB sync status */}
        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">KB sync</h2>
            <SyncButton />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Last full sync" value={formatDate(lastSuccess?.finishedAt ?? null)} />
            <Stat label="Documents" value={String(stats?.docCount ?? 0)} />
            <Stat label="Chunks" value={String(stats?.chunkCount ?? 0)} />
            <Stat
              label="Doc errors"
              value={String(stats?.errorCount ?? 0)}
              danger={(stats?.errorCount ?? 0) > 0}
            />
          </div>

          <h3 className="mt-6 text-sm font-semibold text-muted">Recent sync runs</h3>
          {runs.length === 0 ? (
            <p className="mt-2 text-sm text-faint">No syncs yet. Run one to index the wiki.</p>
          ) : (
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-left text-xs text-faint">
                  <th className="py-1.5 pr-3 font-medium">Started</th>
                  <th className="py-1.5 pr-3 font-medium">Trigger</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 pr-3 font-medium">Docs</th>
                  <th className="py-1.5 font-medium">Chunks</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-edge/60">
                    <td className="py-1.5 pr-3">{formatDate(run.startedAt)}</td>
                    <td className="py-1.5 pr-3">{run.trigger}</td>
                    <td className="py-1.5 pr-3">
                      <StatusBadge status={run.status} />
                      {run.errorMessage && (
                        <span className="ml-2 text-xs text-danger">{run.errorMessage.slice(0, 80)}</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">{run.docCount}</td>
                    <td className="py-1.5">{run.chunkCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {docs.some((d) => d.status === "error") && (
            <>
              <h3 className="mt-6 text-sm font-semibold text-danger">Documents with sync errors</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {docs
                  .filter((d) => d.status === "error")
                  .map((d) => (
                    <li key={d.outlineId} className="rounded-md border border-danger/40 bg-danger/5 px-3 py-1.5">
                      <a href={d.url} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                        {d.title}
                      </a>
                      <span className="ml-2 text-xs text-danger">{d.errorMessage?.slice(0, 160)}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>

        {/* Feedback review */}
        <section className="mt-10">
          <h2 className="text-base font-semibold">Recent feedback</h2>
          {recentFeedback.length === 0 ? (
            <p className="mt-2 text-sm text-faint">No feedback yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {recentFeedback.map((f) => (
                <li key={f.id} className="rounded-lg border border-edge bg-sidebar px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={f.rating === "up" ? "text-accent" : "text-danger"}>
                      {f.rating === "up" ? "👍" : "👎"}
                    </span>
                    <span className="font-medium">{f.userName}</span>
                    <span className="text-xs text-faint">{formatDate(f.createdAt)}</span>
                  </div>
                  {f.comment && <p className="mt-1 text-fg">“{f.comment}”</p>}
                  <p className="mt-1 line-clamp-2 text-xs text-muted">{f.answer}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* KB gaps */}
        <section className="mt-10 pb-10">
          <h2 className="text-base font-semibold">Possibly unanswered questions</h2>
          <p className="mt-1 text-xs text-faint">
            Assistant replies that said the KB doesn&apos;t cover the question — candidates for new wiki pages.
          </p>
          {unanswered.length === 0 ? (
            <p className="mt-2 text-sm text-faint">None detected.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {unanswered.map((m) => (
                <li key={m.id} className="rounded-lg border border-edge px-3 py-2 text-sm">
                  <span className="text-xs text-faint">{formatDate(m.createdAt)}</span>
                  <p className="mt-1 line-clamp-3 text-muted">{m.content}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-edge bg-sidebar px-3 py-2">
      <p className="text-xs text-faint">{label}</p>
      <p className={`text-lg font-semibold ${danger ? "text-danger" : "text-fg"}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    success: "bg-accent/10 text-accent",
    running: "bg-sidebar text-muted",
    error: "bg-danger/10 text-danger",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? ""}`}>
      {status}
    </span>
  );
}
