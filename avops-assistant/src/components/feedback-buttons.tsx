"use client";

import { useState } from "react";

export function FeedbackButtons({ messageId }: { messageId: string }) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [showComment, setShowComment] = useState(false);
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);

  async function send(nextRating: "up" | "down", nextComment?: string) {
    setRating(nextRating);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId,
          rating: nextRating,
          comment: nextComment || undefined,
        }),
      });
    } catch {
      // best-effort; keep the optimistic state
    }
  }

  const buttonClass = (active: boolean) =>
    `rounded p-1 transition-colors ${
      active ? "text-accent" : "text-faint hover:bg-hover hover:text-fg"
    }`;

  return (
    <div className="mt-2 flex items-center gap-1">
      <button
        type="button"
        title="Helpful"
        className={buttonClass(rating === "up")}
        onClick={() => {
          send("up");
          setShowComment(false);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={rating === "up" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z" />
        </svg>
      </button>
      <button
        type="button"
        title="Not helpful"
        className={buttonClass(rating === "down")}
        onClick={() => {
          send("down");
          setShowComment(true);
          setSent(false);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={rating === "down" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z" />
        </svg>
      </button>
      {showComment && !sent && (
        <form
          className="ml-1 flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (rating) send(rating, comment.trim());
            setSent(true);
            setShowComment(false);
          }}
        >
          <input
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What was wrong? (optional)"
            className="w-56 rounded-md border border-edge bg-bg px-2 py-1 text-xs text-fg placeholder-faint outline-none focus:border-accent"
          />
          <button
            type="submit"
            className="rounded-md border border-edge px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
          >
            Send
          </button>
        </form>
      )}
      {sent && <span className="ml-1 text-xs text-faint">Thanks — logged for KB review</span>}
    </div>
  );
}
