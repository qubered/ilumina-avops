import { desc, eq, ilike, or } from "drizzle-orm";
import { db, feedback, messages, user } from "@/lib/db";

export const dynamic = "force-dynamic";

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  }).format(d);
}

export default async function AdminFeedbackPage() {
  const [recentFeedback, unanswered] = await Promise.all([
    db
      .select({
        id: feedback.id,
        rating: feedback.rating,
        comment: feedback.comment,
        createdAt: feedback.createdAt,
        userName: user.name,
        answer: messages.content,
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

  return (
    <div className="pb-12">
      <section className="mt-6">
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

      <section className="mt-10">
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
  );
}
