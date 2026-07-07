import { desc, sql } from "drizzle-orm";
import { conversations, db, feedback, kbDocuments, messages, syncRuns, user } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { countPoints } from "@/lib/rag/store";
import { SyncButton } from "@/components/sync-button";

export const dynamic = "force-dynamic";

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  }).format(d);
}

export default async function AdminOverviewPage() {
  const env = getEnv();

  const [runs, docStats, usage, qdrantPoints] = await Promise.all([
    db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(10),
    db
      .select({
        docCount: sql<number>`count(*)::int`,
        chunkCount: sql<number>`coalesce(sum(${kbDocuments.chunkCount}), 0)::int`,
        errorCount: sql<number>`count(*) filter (where ${kbDocuments.status} = 'error')::int`,
      })
      .from(kbDocuments),
    db
      .select({
        users: sql<number>`(select count(*) from ${user})::int`,
        conversations: sql<number>`(select count(*) from ${conversations})::int`,
        messages: sql<number>`(select count(*) from ${messages})::int`,
        feedback: sql<number>`(select count(*) from ${feedback})::int`,
      })
      .from(sql`(select 1) as one`),
    countPoints().catch(() => null),
  ]);

  const stats = docStats[0];
  const use = usage[0];
  const lastSuccess = runs.find((r) => r.status === "success");
  const docsWithErrors = await db
    .select()
    .from(kbDocuments)
    .where(sql`${kbDocuments.status} = 'error'`);

  const model =
    env.AI_PROVIDER === "codex"
      ? env.CODEX_MODEL
      : env.AI_PROVIDER === "openai"
        ? env.OPENAI_MODEL
        : env.ANTHROPIC_MODEL;

  return (
    <div className="pb-12">
      {/* System */}
      <section className="mt-6">
        <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">
          System
        </h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
          <SystemRow label="Chat model" value={`${model} (${env.AI_PROVIDER})`} />
          <SystemRow label="Web search" value={env.AI_WEB_SEARCH ? "On" : "Off"} />
          <SystemRow
            label="Embeddings"
            value={
              env.EMBEDDINGS_PROVIDER === "ollama"
                ? `${env.EMBEDDINGS_MODEL} (local)`
                : `${env.VOYAGE_MODEL} (voyage)`
            }
          />
          <SystemRow
            label="Live answer resume"
            value={env.REDIS_URL ? "On (Redis)" : "Off — poll on return"}
          />
          <SystemRow
            label="Registration"
            value={env.SIGNUP_KEY ? "Signup key required" : "Open"}
          />
          <SystemRow
            label="Wiki"
            value={env.OUTLINE_URL.replace(/^https?:\/\//, "")}
            href={env.OUTLINE_URL}
          />
        </dl>
      </section>

      {/* Usage */}
      <section className="mt-8">
        <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">
          Usage
        </h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Crew accounts" value={String(use?.users ?? 0)} />
          <Stat label="Conversations" value={String(use?.conversations ?? 0)} />
          <Stat label="Messages" value={String(use?.messages ?? 0)} />
          <Stat label="Feedback" value={String(use?.feedback ?? 0)} />
        </div>
      </section>

      {/* KB sync */}
      <section className="mt-8">
        <div className="flex items-center justify-between border-b border-divider pb-2">
          <h2 className="text-[15px] font-semibold text-text">Knowledge base sync</h2>
          <SyncButton />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Last full sync" value={formatDate(lastSuccess?.finishedAt ?? null)} />
          <Stat label="Documents" value={String(stats?.docCount ?? 0)} />
          <Stat
            label="Chunks"
            value={qdrantPoints === null ? String(stats?.chunkCount ?? 0) : String(qdrantPoints)}
          />
          <Stat
            label="Doc errors"
            value={String(stats?.errorCount ?? 0)}
            danger={(stats?.errorCount ?? 0) > 0}
          />
        </div>

        {runs.length === 0 ? (
          <p className="mt-4 text-sm text-text-3">No syncs yet. Run one to index the wiki.</p>
        ) : (
          <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[540px] text-sm">
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
                      <span className="ml-2 text-xs text-danger">
                        {run.errorMessage.slice(0, 80)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-text-2">{run.docCount}</td>
                  <td className="py-2 text-text-2">{run.chunkCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {docsWithErrors.length > 0 && (
          <>
            <h3 className="mt-6 text-sm font-semibold text-danger">
              Documents with sync errors
            </h3>
            <ul className="mt-2 space-y-1 text-sm">
              {docsWithErrors.map((d) => (
                <li key={d.outlineId} className="rounded-md border border-danger/40 px-3 py-1.5">
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-link hover:underline"
                  >
                    {d.title}
                  </a>
                  <span className="ml-2 text-xs text-danger">
                    {d.errorMessage?.slice(0, 160)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function SystemRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-divider/60 py-1">
      <dt className="shrink-0 text-text-3">{label}</dt>
      <dd className="truncate text-right text-text">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="text-link hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
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
