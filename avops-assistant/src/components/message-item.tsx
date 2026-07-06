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

/**
 * The system prompt makes the model end with a "Sources:" list; the same
 * citations render as structured document rows below. Strip the redundant
 * trailing text list — presentation only, the stored message is untouched.
 */
function stripTrailingSourcesList(text: string): string {
  return text.replace(/\n+(?:#{1,4}\s*)?(?:\*\*)?Sources:?(?:\*\*)?\s*\n(?:\s*(?:[-*•]|\d+\.)\s+.*\n?)*\s*$/i, "");
}

/** Outline's document glyph — citations render as document-list rows. */
function DocIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 13h6M9 17h4" />
    </svg>
  );
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
      <div className="message-in flex justify-end">
        <div
          className={`max-w-[75%] rounded-lg bg-canvas-2 px-3 py-1.5 whitespace-pre-wrap text-text ${compact ? "text-sm" : "text-[15px]"}`}
        >
          {text}
        </div>
      </div>
    );
  }

  const sources = sourcesOf(message);
  const searching = isSearching(message);
  const body = sources.length > 0 ? stripTrailingSourcesList(text) : text;

  return (
    <div className={`message-in ${compact ? "text-sm" : ""}`}>
      {searching && !text && (
        <p className="soft-pulse text-sm text-text-3">Searching the knowledge base…</p>
      )}
      {body && (
        <div className="message-content" style={compact ? { fontSize: "14px" } : undefined}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
            }}
          >
            {body}
          </ReactMarkdown>
        </div>
      )}
      {sources.length > 0 && (
        <div className="mt-3">
          <p className="mb-0.5 px-2 text-[13px] font-medium text-text-3">Sources</p>
          <ul>
            {sources.map((source) => (
              <li key={source.url}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex h-8 items-center gap-2 rounded px-2 text-[15px] text-text-2 transition-colors duration-100 hover:bg-canvas-2 hover:text-text"
                >
                  <span className="text-text-3">
                    <DocIcon />
                  </span>
                  <span className="truncate">{source.title}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-auto shrink-0 text-text-3 opacity-0 transition-opacity duration-100 group-hover:opacity-100">
                    <path d="M7 17 17 7M7 7h10v10" />
                  </svg>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {text && isPersisted(message) && <FeedbackButtons messageId={message.id} />}
    </div>
  );
}
