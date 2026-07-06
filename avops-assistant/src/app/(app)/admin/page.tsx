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
      <div className="mx-auto max-w-[52rem] px-8 py-10">
        <h1 className="text-2xl font-semibold text-text">Admin</h1>

        {/* KB sync status */}
        <section className="mt-8">
          <div className="flex items-center justify-between border-b border-divider pb-2">
            <h2 className="text-[15px] font-semibold text-text">Knowledge base sync</h2>
            <SyncButton />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Last full sync" value={formatDate(lastSuccess?.finishedAt ?? null)} />
            <Stat label="Documents" value={String(stats?.docCount ?? 0)} />
            <Stat label="Chunks" value={String(stats?.chunkCount ?? 0)} />
            <Stat
              label="Doc errors"
              value={String(stats?.errorCount ?? 0)}
              danger={(stats?.errorCount ?? 0) > 0}
            />
          </div>

          {runs.length === 0 ? (
            <p className="mt-4 text-sm text-text-3">
              No syncs yet. Run one to index the wiki.
            </p>
          ) : (
            <table className="mt-5 w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-left text-[13px] text-text-3">
                  <th className="py-1.5 pr-3 font-medium">Started</th>
                  <th className="py-1.5 pr-3 font-medium">Trigger</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 pr-3 font-medium">Docs</th>
                  <th className="py-1.5 font-medium">Chunks</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-divider">
                    <td className="py-2 pr-3 text-text-2">{formatDate(run.startedAt)}</td>
                    <td className="py-2 pr-3 text-text-2">{run.trigger}</td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={run.status} />
                      {run.errorMessage && (
                        <span className="ml-2 text-xs text-danger">{run.errorMessage.slice(0, 80)}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-text-2">{run.docCount}</td>
                    <td className="py-2 text-text-2">{run.chunkCount}</td>
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
                    <li key={d.outlineId} className="rounded-md border border-danger/40 px-3 py-1.5">
                      <a href={d.url} target="_blank" rel="noreferrer" className="font-medium text-link hover:underline">
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
          <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">
            Recent feedback
          </h2>
          {recentFeedback.length === 0 ? (
            <p className="mt-4 text-sm text-text-3">No feedback yet.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {recentFeedback.map((f) => (
                <li key={f.id} className="rounded-md border border-divider bg-menu px-3 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={f.rating === "up" ? "text-success" : "text-danger"}>
                      {f.rating === "up" ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10v12H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h3zm2 12V9.7L12.8 2c1.7 0 3 1.4 2.6 3l-.9 4h5.3a2 2 0 0 1 1.9 2.6l-2.3 8a2 2 0 0 1-1.9 1.4H9z"/></svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17 14V2h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3zm-2-12v12.3L11.2 22c-1.7 0-3-1.4-2.6-3l.9-4H4.2a2 2 0 0 1-1.9-2.6l2.3-8A2 2 0 0 1 6.5 3H15z"/></svg>
                      )}
                    </span>
                    <span className="font-medium text-text">{f.userName}</span>
                    <span className="text-xs text-text-3">{formatDate(f.createdAt)}</span>
                  </div>
                  {f.comment && <p className="mt-1 text-text">“{f.comment}”</p>}
                  <p className="mt-1 line-clamp-2 text-[13px] text-text-2">{f.answer}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* KB gaps */}
        <section className="mt-10 pb-12">
          <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">
            Possibly unanswered questions
          </h2>
          <p className="mt-2 text-[13px] text-text-3">
            Answers that said the wiki doesn&apos;t cover the question — candidates for new pages.
          </p>
          {unanswered.length === 0 ? (
            <p className="mt-3 text-sm text-text-3">None detected.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {unanswered.map((m) => (
                <li key={m.id} className="rounded-md border border-divider px-3 py-2 text-sm">
                  <span className="text-xs text-text-3">{formatDate(m.createdAt)}</span>
                  <p className="mt-1 line-clamp-3 text-text-2">{m.content}</p>
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
    <div className="rounded-md border border-divider bg-menu px-3 py-2">
      <p className="text-[13px] text-text-3">{label}</p>
      <p className={`text-lg font-semibold ${danger ? "text-danger" : "text-text"}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    success: "bg-success/15 text-success",
    running: "bg-canvas-2 text-text-2",
    error: "bg-danger/10 text-danger",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${styles[status] ?? ""}`}>
      {status}
    </span>
  );
}
