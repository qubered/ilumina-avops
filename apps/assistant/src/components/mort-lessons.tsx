"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatProvenanceDate } from "@mort/core/memory/provenance";
import type { MortLesson } from "@/lib/mort-admin";

/**
 * Lessons — what Mort has worked out about how he works (v2 P7).
 *
 * The visible half of the reflection loop. Everything here is already live: a
 * lesson goes into Mort's prompts the moment the nightly reflection files it,
 * on the same bargain as confirm-then-live facts — transparent and reversible
 * beats gated. So this panel has exactly two jobs, and they are both about
 * making that bargain honest: show what he currently believes, WITH the
 * evidence he drew it from, and make retiring one a single click.
 *
 * Retired lessons stay on the list rather than vanishing. They are the record
 * of someone disagreeing with him, and they are also what stops the next
 * reflection re-deriving the same thought and filing it as new.
 */
export function MortLessons({ lessons }: { lessons: MortLesson[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function retire(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/admin/mort-lessons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retire: id }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setError("Request failed");
    } finally {
      setBusy(null);
    }
  }

  const active = lessons.filter((l) => l.status === "active");
  const retired = lessons.filter((l) => l.status === "retired");

  return (
    <section id="lessons" className="mt-10 scroll-mt-6">
      <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">Lessons</h2>
      <p className="mt-2 text-[13px] text-text-3">
        What Mort has worked out from his own record — rejected proposals, crew feedback and corrections —
        distilled by the nightly reflection. Active lessons go into his prompts straight away, above his scope
        and safety rules so they can tune how he works but never override them. Retiring one takes it out of
        the next prompt.
      </p>

      {active.length === 0 ? (
        <p className="mt-3 text-sm text-text-3">
          Nothing learnt yet. The reflection runs with the nightly dream and only files a lesson when there are
          graded proposals, ratings or corrections to draw one from.
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {active.map((l) => (
            <LessonRow key={l.id} lesson={l} busy={busy === l.id} onRetire={() => retire(l.id)} />
          ))}
        </ul>
      )}

      {retired.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[12px] text-text-3">
            {retired.length} retired lesson{retired.length === 1 ? "" : "s"} — kept so Mort can&apos;t re-learn them
          </summary>
          <ul className="mt-2 space-y-1.5 opacity-60">
            {retired.map((l) => (
              <LessonRow key={l.id} lesson={l} busy={false} onRetire={null} />
            ))}
          </ul>
        </details>
      )}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </section>
  );
}

/** Where a lesson applies. Nothing listed means everywhere Mort works. */
function Scope({ scope }: { scope: string[] }) {
  if (scope.length === 0) {
    return <span className="text-[11px] text-text-3">everywhere</span>;
  }
  return (
    <>
      {scope.map((s) => (
        <span key={s} className="rounded border border-divider px-1.5 py-0.5 text-[11px] text-text-3">
          {s}
        </span>
      ))}
    </>
  );
}

function LessonRow({
  lesson,
  busy,
  onRetire,
}: {
  lesson: MortLesson;
  busy: boolean;
  onRetire: (() => void) | null;
}) {
  const when = formatProvenanceDate(lesson.ts);
  return (
    <li className="rounded-md border border-divider bg-menu px-3 py-2 text-sm">
      <div className="flex flex-wrap items-start gap-2">
        <span className="font-medium text-text">{lesson.lesson}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Scope scope={lesson.scope} />
          {onRetire && (
            <button
              onClick={onRetire}
              disabled={busy}
              className="rounded border border-divider px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              {busy ? "…" : "Retire"}
            </button>
          )}
        </span>
      </div>
      {lesson.detail && <p className="mt-1 text-[13px] text-text-2">{lesson.detail}</p>}
      <p className="mt-1 text-[11px] text-text-3">
        {lesson.origin === "dream" ? "learnt in a reflection" : "added by hand"}
        {when && ` · ${when}`}
        {lesson.status === "retired" && (
          <> · retired by {lesson.retiredBy ?? "someone"}{lesson.retiredAt ? ` on ${lesson.retiredAt.slice(0, 10)}` : ""}</>
        )}
      </p>
      {/* The evidence is what makes a lesson answerable rather than assertable:
          every one points back at the journal, feedback or review rows it came
          from, so "why do you think that?" has an answer that isn't the model's
          word for it. */}
      {lesson.evidence.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-t border-divider pt-1.5">
          {lesson.evidence.map((e, i) => (
            <li key={`${e.kind}-${e.id}-${i}`} className="text-[11px] text-text-3">
              <span className="font-medium">
                {e.kind} {e.id}
              </span>
              {e.note && ` — ${e.note}`}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
