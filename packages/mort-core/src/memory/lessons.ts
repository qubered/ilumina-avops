import { createHash, randomUUID } from "node:crypto";
import { pool } from "./db";
import type { Channel } from "../tools/types";

/**
 * Lessons — what Mort has worked out about his own work (MORT_V2_PLAN I.6,
 * decision V2-4).
 *
 * The storage half of the reflection loop: experience → nightly distillation →
 * visible lessons → prompt injection → human-retirable. Deliberately dumb, the
 * same way memory/pending.ts is dumb: rows, one dedupe rule, and one transition
 * out of `active`. What a lesson may say, and whether it earns its place in a
 * prompt, is decided in agent/reflection.ts and agent/lessons-prompt.ts.
 *
 * Nothing here is a tier check. `note_lesson` is a `write:memory` tool narrowed
 * to the dream channel in the registry, and the harness is what enforces that —
 * a store that policed its own callers would be a second, quieter policy.
 */

export type LessonOrigin = "dream" | "human";
export type LessonStatus = "active" | "retired";

/**
 * Where a lesson came from. `id` is the row it points at — a `mort_journal.id`,
 * a `feedback.id`, or a `mort_review_queue.id` — kept as text because those
 * three id spaces are bigint, uuid and bigint respectively and the point of the
 * column is traceability, not joining.
 */
export type LessonEvidence = {
  kind: "journal" | "feedback" | "review";
  id: string;
  /** One line on what that row showed, so the admin panel reads without a join. */
  note?: string;
};

export type Lesson = {
  id: string;
  ts: string;
  lesson: string;
  detail: string | null;
  /** Channels and/or zone/system tags. Empty means "everywhere". */
  scope: string[];
  evidence: LessonEvidence[];
  origin: LessonOrigin;
  status: LessonStatus;
  retiredBy: string | null;
  retiredAt: string | null;
};

const COLS = `id, ts, lesson, detail, scope, evidence, origin, status, retired_by, retired_at`;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapRow(r: Record<string, unknown>): Lesson {
  return {
    id: r.id as string,
    ts: iso(r.ts),
    lesson: r.lesson as string,
    detail: (r.detail as string) ?? null,
    scope: (r.scope as string[]) ?? [],
    evidence: (r.evidence as LessonEvidence[]) ?? [],
    origin: (r.origin as LessonOrigin) ?? "dream",
    status: (r.status as LessonStatus) ?? "active",
    retiredBy: (r.retired_by as string) ?? null,
    retiredAt: r.retired_at ? iso(r.retired_at) : null,
  };
}

/**
 * A lesson's identity: its sentence, normalised.
 *
 * Not the evidence — two reflections a week apart will cite different journal
 * rows for the same realisation, and if the evidence were part of the key the
 * same lesson would land again every night. Normalising away case, punctuation
 * and whitespace catches the near-restatements a model naturally produces
 * ("Ask before creating a page." vs "ask before creating a page"), which is the
 * duplicate that actually happens.
 */
export function lessonKey(lesson: string): string {
  const normalised = lesson
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalised).digest("hex").slice(0, 24);
}

export type LessonInput = {
  lesson: string;
  detail?: string | null;
  scope?: string[];
  evidence?: LessonEvidence[];
  origin?: LessonOrigin;
};

/**
 * File a lesson. Returns the row and whether it was new.
 *
 * ON CONFLICT DO NOTHING against a key that spans every status is the whole of
 * the "a retired lesson never resurfaces as a new duplicate" guarantee: a
 * reflection that reaches the same conclusion a human already retired gets told
 * it is already known, and the retired row is left exactly as the human left it.
 */
export async function recordLesson(input: LessonInput): Promise<{ lesson: Lesson; created: boolean }> {
  const key = lessonKey(input.lesson);
  const { rows } = await pool.query(
    `INSERT INTO mort_lessons (id, lesson, detail, scope, evidence, origin, dedupe_key)
     VALUES ($1,$2,$3,COALESCE($4::text[],'{}'),$5::jsonb,$6,$7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING ${COLS}`,
    [
      randomUUID(),
      input.lesson.trim(),
      input.detail?.trim() || null,
      input.scope?.length ? input.scope : null,
      JSON.stringify(input.evidence ?? []),
      input.origin ?? "dream",
      key,
    ],
  );
  if (rows.length) return { lesson: mapRow(rows[0]), created: true };

  const { rows: existing } = await pool.query(`SELECT ${COLS} FROM mort_lessons WHERE dedupe_key = $1`, [key]);
  return { lesson: mapRow(existing[0]), created: false };
}

/** Every lesson, newest first — the admin panel's view. Retired ones included. */
export async function listLessons(
  opts: { status?: LessonStatus; limit?: number } = {},
): Promise<Lesson[]> {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM mort_lessons
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY ts DESC
      LIMIT $2`,
    [opts.status ?? null, Math.min(Math.max(opts.limit ?? 100, 1), 500)],
  );
  return rows.map(mapRow);
}

/**
 * The active lessons that apply to a channel, newest first.
 *
 * An empty `scope` means the lesson applies everywhere — that is the honest
 * reading of "I didn't say where this applies", and it is also the safe one:
 * the alternative is a lesson learnt from chat feedback silently never reaching
 * the ingest turns that would benefit from it. A scope naming zones or systems
 * alongside a channel still matches on the channel; the extra tags are there
 * for a human reading the panel, not for this filter.
 */
export async function activeLessonsFor(channel: Channel, limit = 10): Promise<Lesson[]> {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM mort_lessons
      WHERE status = 'active'
        AND (cardinality(scope) = 0 OR $1 = ANY(scope))
      ORDER BY ts DESC
      LIMIT $2`,
    [channel, Math.min(Math.max(limit, 1), 50)],
  );
  return rows.map(mapRow);
}

/**
 * Retire a lesson. Only ever moves an active row, so a second click can't
 * rewrite who retired it or when.
 */
export async function retireLesson(id: string, retiredBy: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE mort_lessons SET status = 'retired', retired_by = $2, retired_at = now()
      WHERE id = $1 AND status = 'active'`,
    [id, retiredBy],
  );
  return (rowCount ?? 0) > 0;
}

export async function getLesson(id: string): Promise<Lesson | null> {
  const { rows } = await pool.query(`SELECT ${COLS} FROM mort_lessons WHERE id = $1`, [id]);
  return rows.length ? mapRow(rows[0]) : null;
}
