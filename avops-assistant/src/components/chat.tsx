"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Source } from "@/lib/db/schema";
import { MessageItem } from "./message-item";

export type DbMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: Source[] | null;
};

export const STARTER_QUESTIONS = [
  "How do I patch a camera into the E2?",
  "How do I get public internet in the PFA?",
  "How do I get the audio show file running?",
];

function toUIMessages(dbMessages: DbMessage[]): UIMessage[] {
  return dbMessages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text" as const, text: m.content }],
    metadata: { sources: m.sources ?? [], persisted: true },
  }));
}

export function Chat({
  conversationId,
  initialMessages,
  compact = false,
}: {
  conversationId: string | null;
  initialMessages: DbMessage[];
  compact?: boolean;
}) {
  const convIdRef = useRef<string | null>(conversationId);
  const [creationError, setCreationError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // conversationId travels as per-request body (set in submit); the transport
  // only reshapes the request to { conversationId, message: <last> }.
  // Reconnects (resuming an in-flight answer) hit GET /api/chat.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: {
            ...(body as Record<string, unknown>),
            message: messages[messages.length - 1],
          },
        }),
        prepareReconnectToStreamRequest: () => ({
          api: `/api/chat?conversationId=${convIdRef.current}`,
        }),
      }),
    [],
  );

  // The conversation was left mid-answer (last persisted message is the
  // user's): try to reattach to the live stream on mount. Falls back to the
  // polling below when there is nothing to resume.
  const openedMidAnswer =
    initialMessages.length > 0 &&
    initialMessages[initialMessages.length - 1].role === "user";

  const { messages, sendMessage, status, error, setMessages, clearError } =
    useChat({
      transport,
      resume: Boolean(conversationId) && openedMidAnswer,
      messages: toUIMessages(initialMessages),
      onFinish: async () => {
        // Swap in the persisted messages so ids (needed for feedback) and
        // deduped sources come from the database.
        const id = convIdRef.current;
        if (!id) return;
        try {
          const res = await fetch(`/api/conversations/${id}`);
          if (res.ok) {
            const data = (await res.json()) as { messages: DbMessage[] };
            setMessages(toUIMessages(data.messages));
          }
        } catch {
          // keep the streamed messages; feedback stays disabled for them
        }
      },
    });

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, status]);

  // A conversation can be mid-answer with no local stream attached — the
  // user sent a prompt, closed the tab or switched conversations, and came
  // back (generation continues server-side via consumeStream). While the
  // last message is ours and nothing is streaming here, poll until the
  // persisted answer lands.
  const awaitingAnswer =
    !busy && messages.length > 0 && messages[messages.length - 1].role === "user";

  useEffect(() => {
    if (!awaitingAnswer || !convIdRef.current) return;
    const id = convIdRef.current;
    let stopped = false;

    const poll = () => {
      fetch(`/api/conversations/${id}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { messages: DbMessage[] } | null) => {
          if (stopped || !data) return;
          const last = data.messages[data.messages.length - 1];
          if (last?.role === "assistant") setMessages(toUIMessages(data.messages));
        })
        .catch(() => {
          // transient; next tick retries
        });
    };
    const interval = setInterval(poll, 3000);
    // Answers can take a while with tool loops, but don't poll forever.
    const timeout = setTimeout(() => clearInterval(interval), 5 * 60_000);
    return () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [awaitingAnswer, setMessages]);

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setCreationError(null);

    if (!convIdRef.current) {
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstMessage: trimmed }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        convIdRef.current = data.conversation.id;
        if (!compact) {
          window.history.replaceState(null, "", `/c/${data.conversation.id}`);
          window.dispatchEvent(new Event("conversations:changed"));
        }
      } catch {
        setCreationError("Could not start a conversation. Is the server reachable?");
        return;
      }
    }
    sendMessage(
      { text: trimmed },
      { body: { conversationId: convIdRef.current } },
    );
  }

  const showStarters = messages.length === 0 && !busy;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div
          className={`mx-auto w-full ${compact ? "px-3 py-3" : "max-w-[46rem] px-8 py-8"}`}
        >
          {showStarters ? (
            <div className={compact ? "pt-3" : "pt-20"}>
              <h1 className={`font-brand font-semibold text-text ${compact ? "text-lg" : "text-[26px]"}`}>
                Ask the AV Ops knowledge base
              </h1>
              <p className="mt-1 text-[15px] text-text-2">
                Answers come from the crew wiki, with links to the source pages.
              </p>
              <ul className="mt-6">
                {STARTER_QUESTIONS.map((q) => (
                  <li key={q}>
                    <button
                      type="button"
                      onClick={() => submit(q)}
                      className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-[15px] text-text-2 transition-colors duration-100 hover:bg-canvas-2 hover:text-text"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-3">
                        <circle cx="11" cy="11" r="8" />
                        <path d="m21 21-4.3-4.3" />
                      </svg>
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-7">
              {messages.map((message) => (
                <MessageItem key={message.id} message={message} compact={compact} />
              ))}
              {(status === "submitted" || awaitingAnswer) && (
                <p className="soft-pulse text-sm text-text-3">
                  {awaitingAnswer ? "Answering…" : "Thinking…"}
                </p>
              )}
            </div>
          )}
          {(error || creationError) && (
            <div className="mt-4 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
              {creationError ??
                "The AI backend is unreachable. Try again shortly."}
              {error && (
                <button
                  type="button"
                  className="ml-2 underline"
                  onClick={() => clearError()}
                >
                  Dismiss
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <Composer onSubmit={submit} busy={busy} compact={compact} />
    </div>
  );
}

function Composer({
  onSubmit,
  busy,
  compact,
}: {
  onSubmit: (text: string) => void;
  busy: boolean;
  compact: boolean;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // `/` focuses the composer from anywhere (DESIGN.md §7).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function send() {
    if (busy) return;
    onSubmit(value);
    setValue("");
  }

  return (
    <div className={compact ? "p-2" : "px-8 pb-6"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className={`mx-auto flex w-full items-end gap-2 rounded-md border border-input-border bg-input px-3 py-2 transition-colors duration-100 focus-within:border-input-focus ${compact ? "" : "max-w-[46rem]"}`}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask about AV ops…"
          className="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-[15px] text-text outline-none"
          style={{ fieldSizing: "content" } as React.CSSProperties}
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="flex size-7 shrink-0 items-center justify-center rounded bg-accent text-accent-fg transition-colors duration-100 hover:bg-accent-hover disabled:opacity-40"
          title="Send"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12 7-7 7 7M12 19V5" />
          </svg>
        </button>
      </form>
      {!compact && (
        <p className="mx-auto mt-1.5 max-w-[46rem] px-1 text-xs text-text-3">
          Enter to send · Shift+Enter for a new line · / to focus
        </p>
      )}
    </div>
  );
}
