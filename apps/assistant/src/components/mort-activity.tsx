"use client";

import { useMemo, useState } from "react";
import type {
  MortActiveJob,
  MortActivity,
  MortActivityRow,
  MortLibraryRow,
  MortToolCall,
} from "@/lib/mort-admin";
import { MortDigestPanel } from "./mort-digest";

/**
 * What Mort is doing, what he's working through, and everything he holds.
 *
 * The journal is stored as terse verbs ("hold:no-target", "proposed:ATTACH")
 * because it's also a machine-readable audit trail. Here it's rendered as
 * sentences: a log you skim to answer "is he doing sensible things?" is a
 * different artifact from a table you query.
 */

/** How each journal verb reads to a human, and how loud it should be. */
function describe(row: MortActivityRow): { verb: string; tone: string } {
  const { action } = row;
  if (action.startsWith("proposed:")) return { verb: `Proposed ${prettyAction(action.slice(9))}`, tone: "text-accent" };
  if (action.startsWith("approved:")) return { verb: `Approved ${prettyAction(action.slice(9))}`, tone: "text-success" };
  // Rejections are journaled from P8 on, and are the entry an auditor most
  // wants: "nothing happened" is otherwise invisible.
  if (action.startsWith("rejected:")) return { verb: `Rejected ${prettyAction(action.slice(9))}`, tone: "text-text-3" };
  // A mode change is the loudest thing anyone can do to Mort — going live
  // reads as a warning, because it is one.
  if (action.startsWith("mode:")) {
    const mode = action.slice(5);
    return { verb: `Switched to ${mode} mode`, tone: mode === "live" ? "text-danger" : "text-accent" };
  }
  switch (action) {
    case "doc_created":
      return { verb: "Wrote, from chat", tone: "text-success" };
    case "doc_updated":
      return { verb: "Corrected, from chat", tone: "text-success" };
    case "doc_attached":
      return { verb: "Attached, from chat", tone: "text-success" };
    case "fact_saved":
      return { verb: "Was told a fact", tone: "text-success" };
    case "event_logged":
      return { verb: "Was told what happened", tone: "text-success" };
    case "create":
      return { verb: "Wrote", tone: "text-success" };
    case "update":
      return { verb: "Added to", tone: "text-success" };
    case "attach":
      return { verb: "Attached to", tone: "text-success" };
    case "hold":
      return { verb: "Held in the library", tone: "text-text-2" };
    case "hold:no-target":
      return { verb: "Held — no page for it yet", tone: "text-text-2" };
    case "skip":
      return { verb: "Skipped", tone: "text-text-3" };
    case "dream":
      return { verb: "Looked over the whole KB", tone: "text-accent" };
    case "fact_approved":
      return { verb: "Recorded a fact", tone: "text-success" };
    case "fact_retired":
      return { verb: "Retired a fact", tone: "text-text-2" };
    case "tombstone":
      return { verb: "Flagged as gone", tone: "text-danger" };
    default:
      return { verb: action, tone: "text-text-2" };
  }
}

const prettyAction = (a: string) => (a === "UPDATE_ADDITIVE" ? "an update" : a.toLowerCase());

const ROLE_TONE: Record<string, string> = {
  truth: "text-success",
  structured: "text-accent",
  reference: "text-text-2",
  media: "text-text-2",
  event_log: "text-accent",
  unknown: "text-text-3",
};

function ago(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function MortActivityPanel({ activity, outlineUrl }: { activity: MortActivity; outlineUrl: string }) {
  const { journal, library, queue, toolCalls, digest } = activity;
  return (
    <>
      {queue.length > 0 && <InFlight queue={queue} />}
      {/* The summary first, the raw journal below it: an admin opening this page
          wants "what happened" before "every row it happened in" (P8). */}
      {digest && <MortDigestPanel digest={digest} outlineUrl={outlineUrl} />}
      <Activity journal={journal} outlineUrl={outlineUrl} />
      <ToolLog calls={toolCalls} />
      <Library library={library} />
    </>
  );
}

const OUTCOME_TONE: Record<string, string> = {
  ok: "text-text-3",
  error: "text-danger",
  refused: "text-danger",
};

/**
 * Every tool Mort reached for, on every channel (P4, decision V2-5).
 *
 * Separate from the journal above on purpose. That one answers "why is this
 * page like this" and is a handful of entries a day; this is every kb_search of
 * every turn, and is read for a different question — did anything try to reach
 * past its channel, and is the harness seeing it all.
 *
 * Refusals are pulled to the top of the section rather than left in date order:
 * on the ingest channel a refusal is the signature of a document trying to talk
 * Mort into writing something, and that must not scroll away under a hundred
 * routine searches.
 */
function ToolLog({ calls }: { calls: MortToolCall[] }) {
  const [showAll, setShowAll] = useState(false);
  const refused = calls.filter((c) => c.outcome === "refused");
  const shown = showAll ? calls : refused.length > 0 ? refused : calls.slice(0, 12);

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center gap-2 border-b border-divider pb-2">
        <h2 className="text-[15px] font-semibold text-text">
          Tools he reached for <span className="font-normal text-text-3">({calls.length})</span>
        </h2>
        {calls.length > shown.length && (
          <button
            onClick={() => setShowAll(true)}
            className="ml-auto rounded border border-divider px-2 py-0.5 text-[11px] text-text-2 hover:text-text"
          >
            Show all
          </button>
        )}
      </div>
      <p className="mt-2 text-[13px] text-text-3">
        Every tool call, whatever the channel — including the ones the policy tiers refused.
        {refused.length > 0 && !showAll && ` Showing the ${refused.length} refused first.`}
      </p>

      {shown.length === 0 ? (
        <p className="mt-4 text-sm text-text-3">Nothing yet.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {shown.map((c) => (
            <li key={c.id} className="rounded-md border border-divider bg-menu px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={`text-[12px] font-semibold ${OUTCOME_TONE[c.outcome] ?? "text-text-2"}`}>
                  {c.outcome === "ok" ? "called" : c.outcome}
                </span>
                <span className="font-medium text-text">{c.tool}</span>
                <span className="rounded border border-divider px-1.5 py-0.5 text-[11px] text-text-3">{c.tier}</span>
                <span className="ml-auto shrink-0 text-[11px] text-text-3">{ago(c.ts)}</span>
              </div>
              {c.detail && <p className="mt-1 text-[12px] text-danger">{c.detail}</p>}
              <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-3">
                <span>
                  {c.actor === "system" ? "on his own" : c.actor} · {CHANNEL_LABEL[c.channel as MortActivityRow["channel"]] ?? c.channel}
                </span>
                <span>{c.latencyMs}ms</span>
                {c.conversationId && (
                  <a
                    href={`/c/${c.conversationId}`}
                    className="underline decoration-divider underline-offset-2 hover:decoration-text-3"
                  >
                    conversation
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InFlight({ queue }: { queue: MortActiveJob[] }) {
  const running = queue.filter((j) => j.status === "running").length;
  return (
    <section className="mt-10">
      <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">
        Working through{" "}
        <span className="font-normal text-text-3">
          ({queue.length} file{queue.length === 1 ? "" : "s"}
          {running > 0 && `, ${running} in progress`})
        </span>
      </h2>
      <ul className="mt-3 space-y-1.5">
        {queue.slice(0, 25).map((j) => (
          <li key={j.id} className="flex items-center gap-2 rounded-md border border-divider bg-menu px-3 py-2 text-sm">
            <span className={`text-[11px] font-medium ${j.status === "running" ? "text-success" : "text-text-3"}`}>
              {j.status === "running" ? "● reading" : "queued"}
            </span>
            <span className="truncate font-medium text-text">{j.sourceId}</span>
            {j.force && (
              <span className="shrink-0 text-[11px] text-accent" title="A page it might belong on just appeared">
                re-check
              </span>
            )}
            {j.attempts > 1 && <span className="shrink-0 text-[11px] text-text-3">attempt {j.attempts}</span>}
          </li>
        ))}
      </ul>
      {queue.length > 25 && <p className="mt-2 text-[12px] text-text-3">+{queue.length - 25} more queued.</p>}
    </section>
  );
}

function Activity({ journal, outlineUrl }: { journal: MortActivityRow[]; outlineUrl: string }) {
  return (
    <section className="mt-10">
      <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">What Mort&apos;s been doing</h2>
      {journal.length === 0 ? (
        <p className="mt-3 text-sm text-text-3">Nothing yet. Drop a file in the watched folder.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {journal.map((row, i) => {
            const { verb, tone } = describe(row);
            return (
              <li key={`${row.ts}-${i}`} className="rounded-md border border-divider bg-menu px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={`text-[12px] font-semibold ${tone}`}>{verb}</span>
                  {row.docTitle &&
                    (row.outlineDocumentId && outlineUrl ? (
                      <a
                        href={`${outlineUrl.replace(/\/$/, "")}/doc/${row.outlineDocumentId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-text underline decoration-divider underline-offset-2 hover:decoration-text-3"
                      >
                        {row.docTitle}
                      </a>
                    ) : (
                      <span className="font-medium text-text">{row.docTitle}</span>
                    ))}
                  <span className="ml-auto shrink-0 text-[11px] text-text-3">{ago(row.ts)}</span>
                </div>
                {row.sourceId && <p className="mt-0.5 text-[12px] text-text-3">from {row.sourceId}</p>}
                {row.rationale && <p className="mt-1 text-text-2">{row.rationale}</p>}
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-3">
                  <Attribution row={row} />
                  {row.confidence != null && <span>{Math.round(row.confidence * 100)}% sure</span>}
                  {row.tokens ? <span>{row.tokens.toLocaleString()} tokens</span> : null}
                  {row.model && <span>{row.model}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const CHANNEL_LABEL: Record<MortActivityRow["channel"], string> = {
  chat: "in chat",
  ingest: "from the watch folder",
  dream: "while dreaming",
  admin: "in the admin console",
};

/**
 * Who was behind an entry, and through which door (v2 P2). "On his own" is the
 * honest rendering of actor 'system': nobody asked, Mort decided — which is
 * exactly the row a reader of an audit log wants to spot.
 */
function Attribution({ row }: { row: MortActivityRow }) {
  const who = row.actor === "system" ? "on his own" : row.actor;
  return (
    <span>
      {who} · {CHANNEL_LABEL[row.channel] ?? row.channel}
      {row.conversationId && (
        <>
          {" · "}
          <a
            href={`/c/${row.conversationId}`}
            className="underline decoration-divider underline-offset-2 hover:decoration-text-3"
          >
            conversation
          </a>
        </>
      )}
    </span>
  );
}

function Library({ library }: { library: MortLibraryRow[] }) {
  const [q, setQ] = useState("");

  // Filter here rather than round-tripping: the whole library is already loaded,
  // and typing that filters instantly beats typing that waits on the network.
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return library;
    return library.filter((f) =>
      [f.sourceId, f.summary ?? "", ...f.system, ...f.zone, ...f.entities]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [library, q]);

  const held = library.filter((f) => f.docCount === 0 && f.status === "active").length;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center gap-2 border-b border-divider pb-2">
        <h2 className="text-[15px] font-semibold text-text">
          Mort&apos;s library <span className="font-normal text-text-3">({library.length})</span>
        </h2>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name, summary, gear…"
          className="ml-auto w-56 rounded border border-divider bg-menu px-2 py-1 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <p className="mt-2 text-[13px] text-text-3">
        Every file Mort has been given and what he made of it — including the ones he never turned
        into a page.
        {held > 0 && ` ${held} held, waiting for a page to belong to.`}
      </p>

      {shown.length === 0 ? (
        <p className="mt-4 text-sm text-text-3">
          {library.length === 0 ? "Nothing ingested yet." : "Nothing matches that."}
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {shown.map((f) => {
            const facets = [...f.system, ...f.zone, ...f.entities];
            return (
              <li
                key={f.sourceId}
                className={`rounded-md border border-divider bg-menu px-3 py-2 text-sm ${
                  f.status !== "active" ? "opacity-60" : ""
                }`}
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={`text-[11px] font-semibold ${ROLE_TONE[f.role] ?? "text-text-3"}`}>{f.role}</span>
                  <span className="font-medium text-text">{f.sourceId}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-text-3">
                    {f.status !== "active"
                      ? f.status
                      : f.docCount > 0
                        ? `on ${f.docCount} page${f.docCount === 1 ? "" : "s"}`
                        : f.hasBytes
                          ? "held"
                          : "no page"}
                  </span>
                </div>
                {f.summary && <p className="mt-1 text-text-2">{f.summary}</p>}
                {facets.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {facets.map((t) => (
                      <span key={t} className="rounded border border-divider px-1.5 py-0.5 text-[11px] text-text-3">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
