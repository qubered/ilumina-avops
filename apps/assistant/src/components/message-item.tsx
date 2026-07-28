"use client";

import type { UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MessageProvenance, Source } from "@/lib/db/schema";
import type { ChatCard } from "@/lib/conversation-messages";
import { stripTrailingSourcesList } from "@mort/core/kb/sources";
import { formatProvenanceDate } from "@mort/core/memory/provenance";
import { FeedbackButtons } from "./feedback-buttons";
import { PendingActionCard } from "./pending-action-card";

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Sources: persisted metadata for DB messages, live tool/search parts while streaming. */
function sourcesOf(message: UIMessage): Source[] {
  const meta = message.metadata as { sources?: Source[] } | undefined;
  if (meta?.sources?.length) return meta.sources;

  const collected: Source[] = [];
  for (const part of message.parts) {
    if (part.type === "tool-kb_search" && "output" in part && Array.isArray(part.output)) {
      for (const hit of part.output as { title?: string; url?: string }[]) {
        if (hit?.title && hit?.url) collected.push({ title: hit.title, url: hit.url, kind: "kb" });
      }
    }
    if (part.type === "source-url" && "url" in part && part.url) {
      collected.push({
        title: ("title" in part && part.title) || new URL(part.url).hostname,
        url: part.url,
        kind: "web",
      });
    }
  }
  return [...new Map(collected.map((s) => [s.url, s])).values()];
}

/**
 * Confirmation cards: the persisted ones (with their live status) for DB
 * messages, the freshly-raised ones from tool output while streaming.
 */
function cardsOf(message: UIMessage): ChatCard[] {
  const meta = message.metadata as { pendingActions?: ChatCard[] } | undefined;
  if (meta?.pendingActions?.length) return meta.pendingActions;

  const live = new Map<string, ChatCard>();
  for (const part of message.parts) {
    if (!part.type.startsWith("tool-") || !("output" in part)) continue;
    const output = part.output as
      | { pendingId?: string; tool?: string; preview?: string; payload?: Record<string, unknown> }
      | undefined;
    if (!output?.pendingId || !output.tool) continue;
    live.set(output.pendingId, {
      id: output.pendingId,
      tool: output.tool,
      preview: output.preview ?? "",
      payload: output.payload ?? {},
      status: "pending",
    });
  }
  return [...live.values()];
}

/**
 * Mort is mid-dump: splitting a wall of notes into pages, searching for each
 * one's existing page and drafting a body takes long enough to need saying out
 * loud, or the chat just sits silent.
 */
function isStructuring(message: UIMessage): boolean {
  return message.parts.some(
    (part) =>
      part.type === "tool-brain_dump" &&
      "state" in part &&
      (part.state === "input-streaming" || part.state === "input-available"),
  );
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
 * Provenance chips for taught knowledge the answer used (v2 P2).
 *
 * Persisted-only, unlike sources: which facts an answer actually leaned on is
 * decided against the FINISHED text (see collectProvenance in the chat route),
 * and a chip attached to a half-written sentence would be attributing a claim
 * that hasn't been made yet. They appear on the refetch, a beat later.
 */
function provenanceOf(message: UIMessage): MessageProvenance[] {
  const meta = message.metadata as { provenance?: MessageProvenance[] } | undefined;
  return meta?.provenance ?? [];
}

/** Where a chip points: the message that taught it, or the console that did. */
function chipHref(chip: MessageProvenance): string | null {
  if (chip.via === "chat" && chip.conversationId) {
    return `/c/${chip.conversationId}${chip.messageId ? `#m-${chip.messageId}` : ""}`;
  }
  if (chip.via === "admin") return "/admin/mort#current-state";
  // File-sourced knowledge has no address to link to — the file name IS the
  // citation, and it lives on someone's OneDrive, not on the web.
  return null;
}

function chipLabel(chip: MessageProvenance): string {
  const when = formatProvenanceDate(chip.when);
  const who = chip.who ? `${chip.who} told me` : chip.sourceId ? `From ${chip.sourceId}` : "Recorded";
  return [who, when].filter(Boolean).join(" · ");
}

/** Speech-bubble glyph — this is knowledge somebody said, not a page. */
function ToldIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.9A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
    </svg>
  );
}

function ProvenanceChips({ chips, compact }: { chips: MessageProvenance[]; compact: boolean }) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {chips.map((chip, i) => {
        const href = chipHref(chip);
        const title = `${chip.kind === "fact" ? chip.subject : "Logged"}${chip.value ? ` = ${chip.value}` : ""}${
          chip.via === "chat" ? " — taught in chat" : chip.via === "admin" ? " — approved in the admin console" : ""
        }`;
        const body = (
          <>
            <span className="text-text-3">
              <ToldIcon />
            </span>
            <span className="truncate">{chipLabel(chip)}</span>
          </>
        );
        const className = `flex max-w-full items-center gap-1.5 rounded-full border border-divider bg-menu px-2 py-0.5 text-[11px] text-text-2 ${
          href ? "transition-colors duration-100 hover:border-text-3 hover:text-text" : ""
        }`;
        return href ? (
          <a
            key={`${chip.kind}-${chip.subject}-${i}`}
            href={href}
            title={title}
            // In the widget the app is a different document; a chip that
            // replaced the widget with a full conversation would eat the chat.
            target={compact ? "_blank" : undefined}
            rel={compact ? "noreferrer" : undefined}
            className={className}
          >
            {body}
          </a>
        ) : (
          <span key={`${chip.kind}-${chip.subject}-${i}`} title={title} className={className}>
            {body}
          </span>
        );
      })}
    </div>
  );
}


/** Outline's document glyph — KB citations render as document-list rows. */
function DocIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 13h6M9 17h4" />
    </svg>
  );
}

/** Globe glyph — web citations (manufacturer docs etc.). */
function WebIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function MessageItem({
  message,
  compact,
  highlighted = false,
}: {
  message: UIMessage;
  compact: boolean;
  /** Deep-linked from a provenance chip — the message that taught the fact. */
  highlighted?: boolean;
}) {
  const text = textOf(message);
  // The anchor a provenance chip points at: "Jayden told me the LED wall is at
  // 6m" links back to the exact message where he said it.
  const anchor = `m-${message.id}`;
  const flash = highlighted ? "rounded-lg ring-2 ring-accent/60 ring-offset-4 ring-offset-bg" : "";

  if (message.role === "user") {
    return (
      <div id={anchor} className="message-in flex scroll-mt-6 justify-end">
        <div
          className={`max-w-[75%] rounded-lg bg-canvas-2 px-3 py-1.5 whitespace-pre-wrap text-text ${compact ? "text-sm" : "text-[15px]"} ${flash}`}
        >
          {text}
        </div>
      </div>
    );
  }

  const sources = sourcesOf(message);
  const cards = cardsOf(message);
  const provenance = provenanceOf(message);
  const searching = isSearching(message);
  const structuring = isStructuring(message);
  const body = sources.length > 0 ? stripTrailingSourcesList(text) : text;

  return (
    <div id={anchor} className={`message-in scroll-mt-6 ${compact ? "text-sm" : ""} ${flash}`}>
      {structuring && !text && (
        <p className="soft-pulse text-sm text-text-3">Working out what goes where…</p>
      )}
      {searching && !structuring && !text && (
        <p className="soft-pulse text-sm text-text-3">Searching the knowledge base…</p>
      )}
      {body && (
        <div className="message-content" style={compact ? { fontSize: "14px" } : undefined}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
              // Inline images only from the app's own KB-attachment proxy;
              // anything external degrades to a link (no third-party loads).
              img: ({ src, alt }) =>
                typeof src === "string" && src.startsWith("/api/kb/attachment") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={src} alt={alt ?? ""} loading="lazy" />
                ) : src ? (
                  <a href={String(src)} target="_blank" rel="noreferrer">
                    {alt || String(src)}
                  </a>
                ) : null,
            }}
          >
            {body}
          </ReactMarkdown>
        </div>
      )}
      {cards.map((card) => (
        <PendingActionCard key={card.id} card={card} compact={compact} />
      ))}
      {provenance.length > 0 && <ProvenanceChips chips={provenance} compact={compact} />}
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
                    {source.kind === "web" ? <WebIcon /> : <DocIcon />}
                  </span>
                  <span className="truncate">{source.title}</span>
                  {source.kind === "web" && (
                    <span className="shrink-0 text-[13px] text-text-3">
                      {hostnameOf(source.url)}
                    </span>
                  )}
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
