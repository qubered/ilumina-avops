"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/conversation-messages";
import { MessageItem } from "./message-item";
import { ACTION_DECIDED_EVENT } from "./pending-action-card";

export type DbMessage = ChatMessage;

/** Where this chat is rendered — the widget's belt is narrower (v2 P8). */
export type ChatSurface = "app" | "widget";

/**
 * The empty state teaches the surface (MORT_V2_PLAN Part II).
 *
 * v1's three starters were all lookups, which taught the crew that Mort is a
 * search box. He now remembers what he's told and can say what's changed, and
 * nobody discovers either from a blank composer — so one of each is offered
 * from the start.
 *
 * The widget list is shorter and drops the wiki-shaped one: those tools aren't
 * on its belt, and a starter that leads somewhere Mort has to decline is worse
 * than no starter.
 */
export type Starter = { text: string; kind: "ask" | "teach" | "digest" };

export const STARTER_QUESTIONS: Record<ChatSurface, Starter[]> = {
  app: [
    { text: "How do I patch a camera into the E2?", kind: "ask" },
    { text: "How do I get the audio show file running?", kind: "ask" },
    { text: "Remember this: the LED wall is at 6m on the Main Stage", kind: "teach" },
    { text: "What's changed this week?", kind: "digest" },
  ],
  widget: [
    { text: "How do I patch a camera into the E2?", kind: "ask" },
    { text: "Remember this: we're on the spare DSP this week", kind: "teach" },
    { text: "What's changed this week?", kind: "digest" },
  ],
};

/**
 * One glyph per kind, so the row says what it is before it's read: the search
 * glyph is Outline's own (the empty state reads like a wiki search page), the
 * brain matches the confirmation card a teaching starter leads to, and the
 * clock is the digest.
 */
function StarterIcon({ kind }: { kind: Starter["kind"] }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "shrink-0 text-text-3",
  };
  if (kind === "teach") {
    return (
      <svg {...common}>
        <path d="M12 5a3 3 0 0 0-6 0 3 3 0 0 0-1 5.8A3 3 0 0 0 8 16a3 3 0 0 0 4 2.8V5zM12 5a3 3 0 0 1 6 0 3 3 0 0 1 1 5.8A3 3 0 0 1 16 16a3 3 0 0 1-4 2.8V5z" />
      </svg>
    );
  }
  if (kind === "digest") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function toUIMessages(dbMessages: DbMessage[]): UIMessage[] {
  return dbMessages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text" as const, text: m.content }],
    metadata: {
      sources: m.sources ?? [],
      provenance: m.provenance ?? [],
      pendingActions: m.pendingActions ?? [],
      persisted: true,
    },
  }));
}

export function Chat({
  conversationId,
  initialMessages,
  compact = false,
  surface = "app",
}: {
  conversationId: string | null;
  initialMessages: DbMessage[];
  compact?: boolean;
  /**
   * Which surface this is. `compact` is a layout choice; this is a capability
   * one, and the two are kept apart so a narrow column somewhere else in the
   * app never silently costs Mort his wiki tools.
   */
  surface?: ChatSurface;
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
        // Resume-on-mount only applies to conversations that already exist,
        // so the prop (stable per mount; pages key by conversation id) is
        // the right capture here — not the mutable ref.
        prepareReconnectToStreamRequest: () => ({
          api: `/api/chat?conversationId=${conversationId}`,
        }),
      }),
    [conversationId],
  );

  // The conversation was left mid-answer (last persisted message is the
  // user's): try to reattach to the live stream on mount. Falls back to the
  // polling below when there is nothing to resume.
  const openedMidAnswer =
    initialMessages.length > 0 &&
    initialMessages[initialMessages.length - 1].role === "user";

  // onFinish closes over the refresher defined below (it needs setMessages,
  // which useChat hasn't returned yet at that point).
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  const { messages, sendMessage, status, error, setMessages, clearError } =
    useChat({
      transport,
      resume: Boolean(conversationId) && openedMidAnswer,
      messages: toUIMessages(initialMessages),
      onFinish: async () => {
        await refreshRef.current?.();
      },
    });

  /**
   * Swap in the persisted messages so ids (needed for feedback), deduped
   * sources, and confirmation-card statuses all come from the database. Also
   * how a confirmed card pulls in the outcome message the route appended.
   */
  const refresh = useCallback(async () => {
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
  }, [setMessages]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const onDecided = () => void refresh();
    window.addEventListener(ACTION_DECIDED_EVENT, onDecided);
    return () => window.removeEventListener(ACTION_DECIDED_EVENT, onDecided);
  }, [refresh]);

  const busy = status === "submitted" || status === "streaming";

  // Deep link from a provenance chip: /c/<id>#m-<messageId> opens the
  // conversation AT the message that taught the fact, rather than at the
  // bottom where the newest chatter is. Read once, on mount — after that the
  // usual stick-to-bottom behaviour resumes.
  const [deepLinkId, setDeepLinkId] = useState<string | null>(() =>
    typeof window !== "undefined" && window.location.hash.startsWith("#m-")
      ? window.location.hash.slice(3)
      : null,
  );
  const deepLinkPending = useRef(deepLinkId !== null);

  // Declared before the deep-link effect on purpose: effects run in order, so
  // this one has to see `pending` still set and stand down before the other
  // scrolls to the anchor — otherwise it lands at the bottom regardless.
  useEffect(() => {
    if (deepLinkPending.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, status]);

  useEffect(() => {
    if (!deepLinkPending.current || !deepLinkId) return;
    deepLinkPending.current = false;
    // A stale link (deleted message, wrong conversation) highlights nothing
    // and falls back to the usual stick-to-bottom behaviour.
    const target = document.getElementById(`m-${deepLinkId}`);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    // The ring is a "here it is" flash, not a permanent state.
    const t = setTimeout(() => setDeepLinkId(null), 2600);
    return () => clearTimeout(t);
  }, [deepLinkId]);

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
      { body: { conversationId: convIdRef.current, surface } },
    );
  }

  const showStarters = messages.length === 0 && !busy;
  const starters = STARTER_QUESTIONS[surface];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div
          className={`mx-auto w-full ${compact ? "px-3 py-3" : "max-w-[46rem] px-4 py-6 md:px-8 md:py-8"}`}
        >
          {showStarters ? (
            <div className={compact ? "pt-3" : "pt-20"}>
              <h1 className={`font-brand font-semibold text-text ${compact ? "text-lg" : "text-[26px]"}`}>
                Ask the AV Ops knowledge base
              </h1>
              <p className="mt-1 text-[15px] text-text-2">
                Answers come from the crew wiki, with links to the source pages. Tell him how things
                are now and he&apos;ll remember it — with your name on it.
              </p>
              <ul className="mt-6">
                {starters.map((s) => (
                  <li key={s.text}>
                    <button
                      type="button"
                      onClick={() => submit(s.text)}
                      className="flex min-h-8 w-full items-center gap-2 rounded px-2 py-1 text-left text-[15px] text-text-2 transition-colors duration-100 hover:bg-canvas-2 hover:text-text"
                    >
                      <StarterIcon kind={s.kind} />
                      {s.text}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-7">
              {messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  compact={compact}
                  highlighted={message.id === deepLinkId}
                />
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
    <div className={compact ? "p-2" : "px-4 pb-4 md:px-8 md:pb-6"}>
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
          className="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-base text-text outline-none md:text-[15px]"
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
        <p className="mx-auto mt-1.5 hidden max-w-[46rem] px-1 text-xs text-text-3 md:block">
          Enter to send · Shift+Enter for a new line · / to focus
        </p>
      )}
    </div>
  );
}
