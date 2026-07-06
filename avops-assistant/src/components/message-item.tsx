"use client";

import type { UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Source } from "@/lib/db/schema";
import { FeedbackButtons } from "./feedback-buttons";

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Sources: persisted metadata for DB messages, live kb_search outputs while streaming. */
function sourcesOf(message: UIMessage): Source[] {
  const meta = message.metadata as { sources?: Source[] } | undefined;
  if (meta?.sources?.length) return meta.sources;

  const collected: Source[] = [];
  for (const part of message.parts) {
    if (part.type === "tool-kb_search" && "output" in part && Array.isArray(part.output)) {
      for (const hit of part.output as { title?: string; url?: string }[]) {
        if (hit?.title && hit?.url) collected.push({ title: hit.title, url: hit.url });
      }
    }
  }
  return [...new Map(collected.map((s) => [s.url, s])).values()];
}

function isSearching(message: UIMessage): boolean {
  return message.parts.some(
    (part) =>
      part.type === "tool-kb_search" &&
      "state" in part &&
      (part.state === "input-streaming" || part.state === "input-available"),
  );
}

/** Feedback needs a database id; streamed messages get one after the refetch. */
function isPersisted(message: UIMessage): boolean {
  return Boolean((message.metadata as { persisted?: boolean } | undefined)?.persisted);
}

export function MessageItem({
  message,
  compact,
}: {
  message: UIMessage;
  compact: boolean;
}) {
  const text = textOf(message);

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className={`max-w-[85%] rounded-lg bg-sidebar px-3.5 py-2 whitespace-pre-wrap text-fg ${compact ? "text-sm" : ""}`}
        >
          {text}
        </div>
      </div>
    );
  }

  const sources = sourcesOf(message);
  const searching = isSearching(message);

  return (
    <div className={compact ? "text-sm" : ""}>
      {searching && !text && (
        <p className="animate-pulse text-sm text-muted">Searching the knowledge base…</p>
      )}
      {text && (
        <div className="message-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
      )}
      {sources.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-faint">Sources</span>
          {sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-edge bg-sidebar px-2.5 py-0.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
              </svg>
              {source.title}
            </a>
          ))}
        </div>
      )}
      {text && isPersisted(message) && <FeedbackButtons messageId={message.id} />}
    </div>
  );
}
