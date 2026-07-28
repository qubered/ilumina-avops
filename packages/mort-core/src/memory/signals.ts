import { pool } from "./db";

/**
 * The outcome signals the nightly reflection reads (MORT_V2_PLAN I.6).
 *
 * Every one of these was already being written; three of them were never read
 * by anything. That is the whole premise of P7 — Mort has a record of what he
 * did and how it landed, and until now nothing closed the loop between them:
 *
 *  1. `mort_journal` — every decision, with its rationale and confidence.
 *  2. `mort_review_queue` decisions — approve/reject is ground truth on Mort's
 *     judgement, graded by a human who had to look at the thing anyway.
 *  3. `feedback` — thumbs and comments on chat answers. Written since v1, read
 *     by nothing (MORT_V2_PLAN Part III, "feedback written but never read").
 *  4. Corrections — turns where a human told Mort he was wrong, tagged on the
 *     journal row by the write that fixed it (agent/pending-actions.ts).
 *
 * A note on the `feedback` join: that table belongs to the assistant app, not to
 * core, and both live in the same database. Core reads it here rather than
 * having the assistant push signals across, because the reflection runs in the
 * ingest worker and a nightly job that depended on the web app being up would
 * be a worse design than one narrow read. It is wrapped so that a deployment
 * without the assistant's migrations reflects on the other three signals
 * instead of failing — a missing signal is a thinner reflection, not an outage.
 */

export type JournalSignal = {
  id: number;
  ts: string;
  channel: string;
  actor: string;
  action: string;
  rationale: string | null;
  confidence: number | null;
  sourceId: string | null;
  /** A human contradicted Mort in this turn — the strongest signal there is. */
  corrected: boolean;
};

export type ReviewSignal = {
  id: number;
  action: string;
  status: "approved" | "rejected";
  rationale: string | null;
  decidedBy: string | null;
  decidedAt: string;
};

export type FeedbackSignal = {
  id: string;
  rating: "up" | "down";
  comment: string | null;
  /** The answer that was rated, truncated — the reflection needs the gist. */
  answer: string;
  /** What was asked, truncated. Null when the answer opened the conversation. */
  question: string | null;
  createdAt: string;
};

export type ReflectionSignals = {
  /** How far back this window reaches, in days. */
  days: number;
  journal: JournalSignal[];
  reviews: ReviewSignal[];
  feedback: FeedbackSignal[];
};

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const clip = (s: unknown, n: number): string => {
  const text = String(s ?? "").replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

/**
 * The journal, over the window.
 *
 * Only rows that record a DECISION — `kb_search` and friends live in
 * `mort_tool_calls` and there are thousands of them a day; feeding those to a
 * reflection would bury the four rows that actually say something under the
 * searches that led to them.
 */
export async function journalSignals(days: number, limit = 120): Promise<JournalSignal[]> {
  const { rows } = await pool.query(
    `SELECT id::int AS id, ts, channel, actor, action, rationale, confidence, source_id,
            COALESCE((details->>'corrected')::boolean, false) AS corrected
       FROM mort_journal
      WHERE ts >= now() - make_interval(days => $1::int)
      ORDER BY ts DESC
      LIMIT $2`,
    [days, limit],
  );
  return rows.map((r) => ({
    id: r.id as number,
    ts: iso(r.ts),
    channel: r.channel as string,
    actor: r.actor as string,
    action: r.action as string,
    rationale: (r.rationale as string) ?? null,
    confidence: (r.confidence as number) ?? null,
    sourceId: (r.source_id as string) ?? null,
    corrected: r.corrected === true,
  }));
}

/** Proposals a human graded in the window — the ground truth on Mort's judgement. */
export async function reviewSignals(days: number, limit = 60): Promise<ReviewSignal[]> {
  const { rows } = await pool.query(
    `SELECT id::int AS id, action, status, rationale, decided_by, decided_at
       FROM mort_review_queue
      WHERE status IN ('approved','rejected')
        AND decided_at >= now() - make_interval(days => $1::int)
      ORDER BY decided_at DESC
      LIMIT $2`,
    [days, limit],
  );
  return rows.map((r) => ({
    id: r.id as number,
    action: r.action as string,
    status: r.status as "approved" | "rejected",
    rationale: (r.rationale as string) ?? null,
    decidedBy: (r.decided_by as string) ?? null,
    decidedAt: iso(r.decided_at),
  }));
}

/**
 * Thumbs and comments on chat answers, with the exchange they rated.
 *
 * Best-effort: a deployment whose assistant tables aren't migrated (or an
 * ingest-only stack) gets an empty list and a warning rather than a dead
 * reflection.
 */
export async function feedbackSignals(days: number, limit = 40): Promise<FeedbackSignal[]> {
  try {
    const { rows } = await pool.query(
      // The rated message is Mort's answer; the question is the newest user
      // message before it in the same conversation, which is what makes a
      // thumbs-down legible ("they asked X and got Y") rather than a bare mood.
      `SELECT f.id, f.rating, f.comment, f.created_at, m.content AS answer,
              (SELECT q.content FROM messages q
                WHERE q.conversation_id = m.conversation_id
                  AND q.role = 'user' AND q.created_at <= m.created_at
                ORDER BY q.created_at DESC LIMIT 1) AS question
         FROM feedback f
         JOIN messages m ON m.id = f.message_id
        WHERE f.created_at >= now() - make_interval(days => $1::int)
        ORDER BY f.created_at DESC
        LIMIT $2`,
      [days, limit],
    );
    return rows.map((r) => ({
      id: String(r.id),
      rating: r.rating as "up" | "down",
      comment: (r.comment as string) ?? null,
      answer: clip(r.answer, 400),
      question: r.question ? clip(r.question, 200) : null,
      createdAt: iso(r.created_at),
    }));
  } catch (err) {
    console.warn("[mort] reflection: chat feedback unavailable, reflecting without it:", err);
    return [];
  }
}

/** Everything the reflection gets to look at, over one window. */
export async function collectReflectionSignals(days = 7): Promise<ReflectionSignals> {
  const [journal, reviews, feedback] = await Promise.all([
    journalSignals(days),
    reviewSignals(days),
    feedbackSignals(days),
  ]);
  return { days, journal, reviews, feedback };
}

/**
 * Is there anything here worth spending a model call on?
 *
 * A quiet week is a real answer. Running the reflection over three routine
 * ingests produces a lesson about nothing, and a lessons list padded with
 * nothing is one nobody reads — the same failure the dream's "an empty list is
 * a good answer" rule guards against.
 */
export function worthReflectingOn(signals: ReflectionSignals): boolean {
  const graded = signals.reviews.length + signals.feedback.length;
  const corrections = signals.journal.filter((j) => j.corrected).length;
  // The journal alone is not enough, however busy the week was: it records what
  // Mort did, not how it landed, and "where was I wrong" cannot be answered
  // from a list of things that went to plan.
  return graded + corrections > 0;
}
