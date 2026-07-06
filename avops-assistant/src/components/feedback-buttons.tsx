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

  return (
    <div className="mt-2 flex items-center gap-0.5">
      <button
        type="button"
        title="Helpful"
        aria-pressed={rating === "up"}
        className={`rounded p-1 transition-colors duration-100 ${
          rating === "up" ? "text-accent" : "text-text-3 hover:bg-canvas-2 hover:text-text"
        }`}
        onClick={() => {
          send("up");
          setShowComment(false);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={rating === "up" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z" />
        </svg>
      </button>
      <button
        type="button"
        title="Not helpful"
        aria-pressed={rating === "down"}
        className={`rounded p-1 transition-colors duration-100 ${
          rating === "down" ? "text-danger" : "text-text-3 hover:bg-canvas-2 hover:text-text"
        }`}
        onClick={() => {
          send("down");
          setShowComment(true);
          setSent(false);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={rating === "down" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z" />
        </svg>
      </button>
      {showComment && !sent && (
        <form
          className="ml-1.5 flex items-center gap-1.5"
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
            placeholder="What was wrong?"
            className="h-7 w-56 rounded border border-input-border bg-input px-2 text-[13px] text-text outline-none transition-colors duration-100 focus:border-input-focus"
          />
          <button
            type="submit"
            className="h-7 rounded border border-btn-neutral-border bg-btn-neutral px-2 text-[13px] font-medium text-text transition-colors duration-100 hover:bg-canvas-2"
          >
            Send
          </button>
        </form>
      )}
      {sent && <span className="ml-1.5 text-[13px] text-text-3">Logged for wiki review</span>}
    </div>
  );
}
