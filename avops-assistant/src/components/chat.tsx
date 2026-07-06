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
      }),
    [],
  );

  const { messages, sendMessage, status, error, setMessages, clearError } =
    useChat({
      transport,
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
          className={`mx-auto w-full ${compact ? "px-3 py-3" : "max-w-[46rem] px-6 py-8"}`}
        >
          {showStarters ? (
            <div className={compact ? "pt-4" : "pt-16"}>
              <h2 className={`font-semibold text-fg ${compact ? "text-base" : "text-xl"}`}>
                Ask the AV Ops knowledge base
              </h2>
              <p className="mt-1 text-sm text-muted">
                Answers come from the crew wiki, with links to the source pages.
              </p>
              <div className="mt-5 flex flex-col items-start gap-2">
                {STARTER_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => submit(q)}
                    className="rounded-lg border border-edge bg-bg px-3 py-2 text-left text-sm text-fg shadow-sm transition-colors hover:border-accent hover:text-accent"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((message) => (
                <MessageItem key={message.id} message={message} compact={compact} />
              ))}
              {status === "submitted" && (
                <p className="animate-pulse text-sm text-muted">Thinking…</p>
              )}
            </div>
          )}
          {(error || creationError) && (
            <div className="mt-4 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
              {creationError ??
                "The assistant hit an error. Check that the AI backend is reachable, then try again."}
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

  // `/` focuses the composer from anywhere (brief §8).
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
    <div className={`border-t border-edge bg-bg ${compact ? "p-2" : "p-4"}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className={`mx-auto flex w-full items-end gap-2 ${compact ? "" : "max-w-[46rem]"}`}
      >
        <textarea
          ref={textareaRef}
          rows={compact ? 1 : 2}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask about AV ops… (Enter to send, / to focus)"
          className="max-h-40 flex-1 resize-none rounded-lg border border-edge bg-bg px-3 py-2 text-[15px] text-fg placeholder-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="rounded-lg bg-accent px-3.5 py-2 font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-50"
          title="Send"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
          </svg>
        </button>
      </form>
    </div>
  );
}
