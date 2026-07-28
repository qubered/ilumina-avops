import { pool } from "./db";
import type { JournalChannel } from "./index";

/**
 * "What's changed this week?" (MORT_V2_PLAN Part II).
 *
 * One function, two readers: the chat tool that answers the question in
 * conversation, and the admin console's activity panel. That is the whole point
 * of it living here rather than being assembled twice — a digest that disagreed
 * with the panel for the same window would make both of them untrustworthy, and
 * nobody would be able to say which one was wrong.
 *
 * The window is a HALF-OPEN interval [since, until): a digest for "the last 7
 * days" run twice in one afternoon covers the same days both times, and two
 * adjacent windows never double-count the row on the boundary.
 *
 * Deliberately summary-shaped rather than a query result. It answers "what
 * happened" — pages written, facts learnt, proposals decided, what's still
 * waiting — and leaves "why exactly" to `mort_memory`, which is the tool for
 * interrogating one decision.
 */

export type DigestWindow = {
  /** Inclusive ISO timestamp. */
  since: string;
  /** Exclusive ISO timestamp. */
  until: string;
  /** Whole days spanned, as asked for. */
  days: number;
};

/** A page Mort wrote to, and what he did to it. */
export type DigestPage = {
  action: "created" | "updated" | "attached" | "removed";
  title: string | null;
  outlineDocumentId: string | null;
  when: string;
  by: string;
  channel: JournalChannel;
  conversationId: string | null;
  rationale: string | null;
};

/** A current-state fact that started (or stopped) being true in the window. */
export type DigestFact = {
  id: number;
  factKey: string;
  value: string;
  scope: string | null;
  /** What this fact replaced, when it corrected an earlier answer. */
  replaced: string | null;
  by: string;
  when: string;
  taughtVia: string;
  conversationId: string | null;
  retired: boolean;
};

/** A review-queue proposal decided in the window. */
export type DigestReview = {
  id: number;
  action: string;
  title: string | null;
  status: "approved" | "rejected";
  by: string | null;
  when: string;
};

/** A lesson the nightly reflection drew (P7). */
export type DigestLesson = {
  id: string;
  lesson: string;
  scope: string[];
  when: string;
  status: string;
};

export type ChangeDigest = {
  window: DigestWindow;
  pages: DigestPage[];
  facts: DigestFact[];
  events: Array<{ actionText: string; occurredOn: string | null; by: string | null; when: string }>;
  reviews: DigestReview[];
  lessons: DigestLesson[];
  /** Still waiting on a human at the end of the window. */
  outstanding: { reviews: number; cards: number };
  /** Counts, so a caller can say "quiet week" without walking every list. */
  totals: { pages: number; facts: number; events: number; reviews: number; lessons: number };
};

/** Which journal verbs are a page actually changing, and what to call each. */
const PAGE_ACTIONS: Record<string, DigestPage["action"]> = {
  create: "created",
  doc_created: "created",
  "approved:CREATE": "created",
  update: "updated",
  doc_updated: "updated",
  "approved:UPDATE_ADDITIVE": "updated",
  attach: "attached",
  doc_attached: "attached",
  "approved:ATTACH": "attached",
  tombstone: "removed",
  "approved:tombstone": "removed",
};

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/**
 * Resolve a window from a day count. `days` is clamped hard: a digest is a
 * summary, and "the last three years" is a report.
 */
export function digestWindow(days = 7, now: Date = new Date()): DigestWindow {
  const clamped = Math.min(90, Math.max(1, Math.round(days)));
  const until = now;
  const since = new Date(until.getTime() - clamped * 24 * 60 * 60 * 1000);
  return { since: since.toISOString(), until: until.toISOString(), days: clamped };
}

export async function changeDigest(opts: { days?: number; now?: Date } = {}): Promise<ChangeDigest> {
  const window = digestWindow(opts.days ?? 7, opts.now);
  const args = [window.since, window.until];

  const [pages, facts, events, reviews, lessons, outstanding] = await Promise.all([
    digestPages(args),
    digestFacts(args),
    digestEvents(args),
    digestReviews(args),
    digestLessons(args),
    digestOutstanding(),
  ]);

  return {
    window,
    pages,
    facts,
    events,
    reviews,
    lessons,
    outstanding,
    totals: {
      pages: pages.length,
      facts: facts.length,
      events: events.length,
      reviews: reviews.length,
      lessons: lessons.length,
    },
  };
}

async function digestPages(args: string[]): Promise<DigestPage[]> {
  const { rows } = await pool.query(
    `SELECT j.ts, j.action, j.rationale, j.actor, j.channel, j.conversation_id,
            COALESCE(j.outline_document_id, d.outline_document_id) AS outline_document_id,
            d.title AS doc_title
       FROM mort_journal j
       LEFT JOIN mort_docs d
         ON d.mort_id = j.mort_id OR d.outline_document_id = j.outline_document_id
      WHERE j.ts >= $1::timestamptz AND j.ts < $2::timestamptz
        AND j.action = ANY($3::text[])
      ORDER BY j.ts DESC
      LIMIT 100`,
    [...args, Object.keys(PAGE_ACTIONS)],
  );
  return rows.map((r) => ({
    action: PAGE_ACTIONS[r.action as string] ?? "updated",
    title: r.doc_title ?? null,
    outlineDocumentId: r.outline_document_id ?? null,
    when: iso(r.ts),
    by: (r.actor as string) ?? "system",
    channel: (r.channel as JournalChannel) ?? "ingest",
    conversationId: (r.conversation_id as string) ?? null,
    rationale: (r.rationale as string) ?? null,
  }));
}

/**
 * Facts that changed in the window — learnt, corrected, or retired.
 *
 * `created_at` rather than `effective_from` is the right clock here: a fact
 * backdated to last month ("this has been true since the bump-in") is still
 * news THIS week, and a digest that hid it would be hiding the thing a reader
 * most needs to know.
 */
async function digestFacts(args: string[]): Promise<DigestFact[]> {
  const { rows } = await pool.query(
    `SELECT f.id::int AS id, f.fact_key, f.value, f.scope, f.approved_by, f.created_at,
            f.taught_via, f.conversation_id, f.effective_to,
            prev.value AS replaced
       FROM mort_facts f
       LEFT JOIN mort_facts prev ON prev.id = f.supersedes
      WHERE f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz
      ORDER BY f.created_at DESC
      LIMIT 100`,
    args,
  );
  return rows.map((r) => ({
    id: r.id as number,
    factKey: r.fact_key as string,
    value: r.value as string,
    scope: (r.scope as string) ?? null,
    replaced: (r.replaced as string) ?? null,
    by: r.approved_by as string,
    when: iso(r.created_at),
    taughtVia: (r.taught_via as string) ?? "admin",
    conversationId: (r.conversation_id as string) ?? null,
    // Learnt and closed off inside the same window: worth saying, because
    // "we decided X on Tuesday and un-decided it on Thursday" reads as noise
    // otherwise.
    retired: r.effective_to != null,
  }));
}

async function digestEvents(args: string[]): Promise<ChangeDigest["events"]> {
  const { rows } = await pool.query(
    // `ingested_at` is when Mort learnt of it; `occurred_on` is when it
    // happened. The window is on the former for the same reason facts use
    // created_at — someone logging Tuesday's work on Friday is Friday's news.
    `SELECT action_text, occurred_on, reported_by, ingested_at
       FROM mort_events
      WHERE ingested_at >= $1::timestamptz AND ingested_at < $2::timestamptz
      ORDER BY ingested_at DESC
      LIMIT 100`,
    args,
  );
  return rows.map((r) => ({
    actionText: r.action_text as string,
    occurredOn: r.occurred_on ? String(r.occurred_on).slice(0, 10) : null,
    by: (r.reported_by as string) ?? null,
    when: iso(r.ingested_at),
  }));
}

async function digestReviews(args: string[]): Promise<DigestReview[]> {
  const { rows } = await pool.query(
    `SELECT q.id::int AS id, q.action, q.status, q.decided_by, q.decided_at, q.payload
       FROM mort_review_queue q
      WHERE q.decided_at >= $1::timestamptz AND q.decided_at < $2::timestamptz
        AND q.status IN ('approved','rejected')
      ORDER BY q.decided_at DESC
      LIMIT 100`,
    args,
  );
  return rows.map((r) => ({
    id: r.id as number,
    action: r.action as string,
    title: ((r.payload as { title?: string } | null)?.title as string) ?? null,
    status: r.status as "approved" | "rejected",
    by: (r.decided_by as string) ?? null,
    when: iso(r.decided_at),
  }));
}

/**
 * Lessons the nightly reflection drew in the window (P7).
 *
 * Retired ones are included and flagged rather than filtered out: a lesson
 * dropped this week is exactly the sort of thing "what's changed?" is asking
 * about, and hiding it would make the digest quieter than the truth.
 */
async function digestLessons(args: string[]): Promise<DigestLesson[]> {
  const { rows } = await pool.query(
    `SELECT id, lesson, scope, ts, status
       FROM mort_lessons
      WHERE ts >= $1::timestamptz AND ts < $2::timestamptz
      ORDER BY ts DESC
      LIMIT 50`,
    args,
  );
  return rows.map((r) => ({
    id: r.id as string,
    lesson: r.lesson as string,
    scope: (r.scope as string[]) ?? [],
    when: iso(r.ts),
    status: (r.status as string) ?? "active",
  }));
}

/**
 * What is still waiting on somebody. Not windowed on purpose: a proposal raised
 * a month ago and never answered belongs in this week's digest precisely
 * because nothing has happened to it.
 */
async function digestOutstanding(): Promise<ChangeDigest["outstanding"]> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM mort_review_queue WHERE status = 'pending')     AS reviews,
       (SELECT count(*)::int FROM mort_pending_actions WHERE status = 'pending')  AS cards`,
  );
  return { reviews: rows[0]?.reviews ?? 0, cards: rows[0]?.cards ?? 0 };
}
