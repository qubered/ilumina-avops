import type { MortDigest } from "@/lib/mort-admin";

/**
 * "What's changed" — the same digest the chat answers from (MORT_V2_PLAN
 * Part II).
 *
 * There is no second query here. `changeDigest` in core produced this object,
 * the `change_digest` tool reads that same function for the same window, and
 * this component only decides how it looks. That's the acceptance case for P8
 * made structural rather than promised: the panel and the conversation cannot
 * drift, because there is only one thing to drift from.
 *
 * Grouped by day rather than listed flat because the question behind it is
 * "what happened while I was away", and a reader answers that a day at a time.
 */

type Entry = {
  when: string;
  tone: string;
  label: string;
  text: string;
  detail?: string | null;
  href?: string | null;
};

const dayOf = (iso: string) => iso.slice(0, 10);

function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  if (day === yesterday) return "Yesterday";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

const PAGE_VERB: Record<string, string> = {
  created: "Wrote",
  updated: "Corrected",
  attached: "Attached to",
  removed: "Removed",
};

/** Where a change came from, said the way the activity panel says it. */
const CHANNEL_LABEL: Record<string, string> = {
  chat: "in chat",
  ingest: "from the watch folder",
  dream: "while dreaming",
  admin: "in the admin console",
};

function entriesOf(digest: MortDigest, outlineUrl: string): Entry[] {
  const base = outlineUrl.replace(/\/$/, "");
  const entries: Entry[] = [];

  for (const p of digest.pages) {
    entries.push({
      when: p.when,
      tone: p.action === "removed" ? "text-danger" : "text-success",
      label: PAGE_VERB[p.action] ?? "Changed",
      text: p.title ?? "a page",
      detail: `${p.by === "system" ? "on his own" : p.by} · ${CHANNEL_LABEL[p.channel] ?? p.channel}`,
      href: p.outlineDocumentId && base ? `${base}/doc/${p.outlineDocumentId}` : null,
    });
  }

  for (const f of digest.facts) {
    const scope = f.scope ? ` (${f.scope})` : "";
    entries.push({
      when: f.when,
      tone: f.retired ? "text-text-2" : "text-accent",
      label: f.replaced ? "Corrected" : f.retired ? "Retired" : "Learnt",
      text: `${f.factKey}${scope} = ${f.value}`,
      // The value it replaced is the part that makes a fact change readable —
      // "6m" alone doesn't tell you anything moved.
      detail: [f.replaced ? `was “${f.replaced}”` : null, `${f.by} · taught ${f.taughtVia === "chat" ? "in chat" : "in the console"}`]
        .filter(Boolean)
        .join(" · "),
      href: f.conversationId ? `/c/${f.conversationId}` : null,
    });
  }

  for (const e of digest.events) {
    entries.push({
      when: e.when,
      tone: "text-text-2",
      label: "Logged",
      text: e.actionText,
      detail: [e.occurredOn ? `happened ${e.occurredOn}` : null, e.by].filter(Boolean).join(" · ") || null,
    });
  }

  for (const r of digest.reviews) {
    entries.push({
      when: r.when,
      tone: r.status === "approved" ? "text-success" : "text-text-3",
      label: r.status === "approved" ? "Approved" : "Rejected",
      text: r.title ?? `proposal #${r.id}`,
      detail: [r.action, r.by].filter(Boolean).join(" · ") || null,
    });
  }

  for (const l of digest.lessons) {
    entries.push({
      when: l.when,
      tone: "text-accent",
      label: l.status === "retired" ? "Dropped a lesson" : "Learnt a lesson",
      text: l.lesson,
      detail: l.scope.length > 0 ? l.scope.join(", ") : null,
    });
  }

  return entries.sort((a, b) => b.when.localeCompare(a.when));
}

export function MortDigestPanel({ digest, outlineUrl }: { digest: MortDigest; outlineUrl: string }) {
  const entries = entriesOf(digest, outlineUrl);
  const today = digest.window.until.slice(0, 10);

  const days: Array<[string, Entry[]]> = [];
  for (const entry of entries) {
    const day = dayOf(entry.when);
    const last = days[days.length - 1];
    if (last && last[0] === day) last[1].push(entry);
    else days.push([day, [entry]]);
  }

  const { outstanding, totals } = digest;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline gap-x-2 border-b border-divider pb-2">
        <h2 className="text-[15px] font-semibold text-text">What&apos;s changed</h2>
        <span className="text-[13px] text-text-3">last {digest.window.days} days</span>
      </div>
      <p className="mt-2 text-[13px] text-text-3">
        The same summary Mort gives in chat when you ask him what&apos;s changed this week — one
        source, so the two can&apos;t disagree.
        {(outstanding.reviews > 0 || outstanding.cards > 0) && (
          <>
            {" "}
            Still waiting: {outstanding.reviews} proposal{outstanding.reviews === 1 ? "" : "s"} and{" "}
            {outstanding.cards} unanswered confirmation{outstanding.cards === 1 ? "" : "s"}.
          </>
        )}
      </p>

      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-text-3">
          Nothing changed in the last {digest.window.days} days.
        </p>
      ) : (
        <>
          <p className="mt-3 text-[12px] text-text-3">
            {totals.pages} page{totals.pages === 1 ? "" : "s"} · {totals.facts} fact
            {totals.facts === 1 ? "" : "s"} · {totals.events} event{totals.events === 1 ? "" : "s"} ·{" "}
            {totals.reviews} proposal{totals.reviews === 1 ? "" : "s"} decided
            {totals.lessons > 0 && ` · ${totals.lessons} lesson${totals.lessons === 1 ? "" : "s"}`}
          </p>
          <div className="mt-3 space-y-4">
            {days.map(([day, rows]) => (
              <div key={day}>
                <p className="text-[12px] font-medium text-text-3">{dayLabel(day, today)}</p>
                <ul className="mt-1.5 space-y-1.5">
                  {rows.map((row, i) => (
                    <li key={`${day}-${i}`} className="rounded-md border border-divider bg-menu px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className={`text-[12px] font-semibold ${row.tone}`}>{row.label}</span>
                        {row.href ? (
                          <a
                            href={row.href}
                            {...(row.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                            className="font-medium text-text underline decoration-divider underline-offset-2 hover:decoration-text-3"
                          >
                            {row.text}
                          </a>
                        ) : (
                          <span className="font-medium text-text">{row.text}</span>
                        )}
                        <span className="ml-auto shrink-0 text-[11px] text-text-3">{row.when.slice(11, 16)}</span>
                      </div>
                      {row.detail && <p className="mt-0.5 text-[12px] text-text-3">{row.detail}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
