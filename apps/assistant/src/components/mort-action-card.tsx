"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The confirmation card (MORT_V2_PLAN §I.4 step 2, Part II).
 *
 * Mort's write tools never write — they park a payload and return one of these
 * shapes. This renders it: a diff for a doc edit, a preview for a new page, a
 * restatement for a fact or event, with Confirm / Send to review / Cancel.
 *
 * The card is the honest surface of the whole feature. If it shows the wrong
 * before/after, a user approves something they didn't read — so everything here
 * comes from what the server computed at propose time, and nothing is
 * re-derived in the browser.
 */

export type DiffLine = { kind: "context" | "add" | "remove"; text: string };

export type MortActionResult =
  | {
      status: "pending_confirmation";
      pendingId: string;
      tool: string;
      title: string;
      preview: string;
      diff?: DiffLine[];
      docUrl?: string;
      warnings?: string[];
    }
  | { status: "queued_for_review"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "error"; error: string }
  | { status: "applied"; summary: string }
  | {
      status: "split";
      pages?: MortActionResult[];
      facts?: MortActionResult[];
      events?: MortActionResult[];
      dropped?: string[];
    };

/** Narrow an arbitrary tool output to something this component can render. */
export function isMortActionResult(value: unknown): value is MortActionResult {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return (
    status === "pending_confirmation" ||
    status === "queued_for_review" ||
    status === "blocked" ||
    status === "error" ||
    status === "applied" ||
    status === "split"
  );
}

const TOOL_LABEL: Record<string, string> = {
  apply_doc_edit: "Correction",
  create_doc: "New page",
  attach_source: "Attachment",
  save_fact: "Fact",
  log_event: "Event log",
};

export function MortActionCard({ result }: { result: MortActionResult }) {
  if (result.status === "split") {
    const groups = [
      { label: "Pages", items: result.pages ?? [] },
      { label: "Facts", items: result.facts ?? [] },
      { label: "Events", items: result.events ?? [] },
    ].filter((g) => g.items.length > 0);

    return (
      <div className="mt-3 space-y-3">
        {groups.map((group) => (
          <div key={group.label} className="space-y-2">
            <p className="px-1 text-[13px] font-medium text-text-3">{group.label}</p>
            {group.items.map((item, i) => (
              <MortActionCard key={i} result={item} />
            ))}
          </div>
        ))}
        {result.dropped && result.dropped.length > 0 && (
          <Notice tone="warn">Not proposed: {result.dropped.join("; ")}.</Notice>
        )}
      </div>
    );
  }

  if (result.status === "queued_for_review") {
    return <Notice tone="info">Sent to the admin review queue. {result.reason}</Notice>;
  }
  if (result.status === "blocked") {
    return <Notice tone="warn">{result.reason}</Notice>;
  }
  if (result.status === "error") {
    return <Notice tone="danger">{result.error}</Notice>;
  }
  if (result.status === "applied") {
    return <Notice tone="success">{result.summary}</Notice>;
  }

  return <PendingCard result={result} />;
}

type Decided = { kind: "confirmed" | "review" | "cancelled"; message: string };

function PendingCard({ result }: { result: Extract<MortActionResult, { status: "pending_confirmation" }> }) {
  const [decided, setDecided] = useState<Decided | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "confirm" | "review" | "cancel") {
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/mort/actions/${result.pendingId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; summary?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't go through. Try again.");
        return;
      }
      setDecided(
        decision === "confirm"
          ? { kind: "confirmed", message: data.summary ?? "Done." }
          : decision === "review"
            ? { kind: "review", message: "Sent to the admin review queue." }
            : { kind: "cancelled", message: "Cancelled — nothing was changed." },
      );
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (decided) {
    return (
      <Notice tone={decided.kind === "cancelled" ? "info" : decided.kind === "review" ? "info" : "success"}>
        {decided.message}
      </Notice>
    );
  }

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-input-border bg-canvas-2">
      <div className="flex items-baseline gap-2 border-b border-input-border px-3 py-2">
        <span className="text-[13px] font-medium text-text-3">{TOOL_LABEL[result.tool] ?? "Change"}</span>
        <span className="truncate text-[15px] font-medium text-text">{result.title}</span>
        {result.docUrl && (
          <a
            href={result.docUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto shrink-0 text-[13px] text-text-3 underline hover:text-text"
          >
            Open page
          </a>
        )}
      </div>

      <div className="space-y-2 px-3 py-2">
        <div className="message-content text-[14px]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.preview}</ReactMarkdown>
        </div>

        {result.diff && result.diff.length > 0 && <Diff lines={result.diff} />}

        {(result.warnings ?? []).map((w) => (
          <Notice key={w} tone="warn">
            {w}
          </Notice>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-input-border px-3 py-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => decide("confirm")}
          className="h-7 rounded bg-accent px-3 text-[13px] font-medium text-accent-fg transition-colors duration-100 hover:bg-accent-hover disabled:opacity-40"
        >
          {busy === "confirm" ? "Applying…" : "Confirm"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => decide("review")}
          className="h-7 rounded border border-btn-neutral-border bg-btn-neutral px-3 text-[13px] text-text-2 transition-colors duration-100 hover:text-text disabled:opacity-40"
        >
          Send to review
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => decide("cancel")}
          className="h-7 rounded px-2 text-[13px] text-text-3 transition-colors duration-100 hover:text-text disabled:opacity-40"
        >
          Cancel
        </button>
        <span className="ml-auto text-[12px] text-text-3">Nothing is saved until you confirm</span>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

/**
 * The before/after itself. Colour alone can't carry the meaning (colour-blind
 * crew, a phone in daylight at the back of a venue), so every line keeps its
 * +/− gutter character.
 */
function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="max-h-80 overflow-auto rounded border border-code-border bg-code p-2 text-[12.5px] leading-[1.5]">
      <code>
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.kind === "add"
                ? "text-[color:var(--success)]"
                : line.kind === "remove"
                  ? "text-danger line-through decoration-danger/40"
                  : "text-text-3"
            }
          >
            <span className="select-none opacity-60">
              {line.kind === "add" ? "+ " : line.kind === "remove" ? "− " : "  "}
            </span>
            {line.text || " "}
          </div>
        ))}
      </code>
    </pre>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "info" | "warn" | "danger" | "success";
  children: React.ReactNode;
}) {
  const style = {
    info: "border-input-border bg-canvas-2 text-text-2",
    warn: "border-[color:var(--highlight)] bg-[color:var(--highlight)]/15 text-text-2",
    danger: "border-danger/40 bg-danger/5 text-danger",
    success: "border-[color:var(--success)]/40 bg-[color:var(--success)]/10 text-text-2",
  }[tone];
  return <div className={`mt-2 rounded-md border px-3 py-2 text-[13px] ${style}`}>{children}</div>;
}
