"use client";

import { useState } from "react";
import type { ChatCard } from "@/lib/conversation-messages";

/**
 * The confirmation card — the whole of "Mort learns things" as far as the crew
 * is concerned (MORT_V2_PLAN I.4). Mort proposes; this is where a human turns
 * the proposal into a write, with their name on it.
 *
 * Nothing here decides anything: Confirm and Cancel post to routes that take
 * the acting user from the session and re-check policy. The card is a view of
 * a row, not a source of authority.
 */

/** Fired after a decision so the conversation picks up the appended outcome. */
export const ACTION_DECIDED_EVENT = "mort:action-decided";

type FieldSpec = { key: string; label: string; type?: "date"; placeholder?: string };

const EDITABLE: Record<string, FieldSpec[]> = {
  save_fact: [
    { key: "factKey", label: "Fact", placeholder: "led-wall-height" },
    { key: "value", label: "Value", placeholder: "6m" },
    { key: "scope", label: "Scope", placeholder: "Main Stage" },
    { key: "effectiveFrom", label: "From", type: "date" },
    { key: "note", label: "Note" },
  ],
  log_event: [
    { key: "actionText", label: "What was done" },
    { key: "occurredOn", label: "When", type: "date" },
    { key: "event", label: "Event", placeholder: "Bump-in" },
  ],
  // Retiring is a yes/no about one identified fact — there is nothing to edit
  // without turning it into a different action.
  retire_fact: [],
};

const TITLES: Record<string, string> = {
  save_fact: "Remember this?",
  retire_fact: "Forget this?",
  log_event: "Add to the event log?",
  apply_doc_edit: "Correct this page?",
  create_doc: "Write this page?",
  attach_source: "Attach this file?",
  mcp_call: "Run this on the gear?",
  set_mode: "Change how Mort operates?",
};

/**
 * A card that reaches real equipment (P5). Nothing about the flow differs —
 * the tool proposed, a human confirms — but the phrasing does: "nothing is
 * saved until you confirm" is the wrong promise when what's on the other end
 * is a contactor.
 */
const WORLD_TOOLS = new Set(["mcp_call"]);

/** A wiki change can be handed to an admin instead of applied (P3). */
const KB_TOOLS = new Set(["apply_doc_edit", "create_doc", "attach_source"]);

/** Operator actions taken through the conversation (P8). */
const ADMIN_TOOLS = new Set(["decide_review", "set_mode"]);

/**
 * The heading. Mostly a lookup, except for `decide_review` — approving and
 * rejecting the same proposal are opposite actions and must not share a title,
 * because the title is the part someone skims before pressing Confirm.
 */
function titleOf(card: ChatCard): string {
  if (card.tool === "decide_review") {
    return card.payload.decision === "reject" ? "Reject this proposal?" : "Approve this proposal?";
  }
  return TITLES[card.tool] ?? "Confirm?";
}

/**
 * The line beside the buttons for an operator card. Says what happens on
 * Confirm rather than what doesn't — "nothing is saved until you confirm" is
 * the wrong reassurance when the thing on the other end is a write to the wiki
 * or the mode every future write obeys.
 */
function operatorNote(card: ChatCard): string {
  if (card.tool === "set_mode") return "This changes how Mort operates from now on";
  return card.payload.decision === "reject"
    ? "Nothing is written — the proposal is dropped"
    : "This carries the proposal out straight away";
}

const DECIDED: Record<string, string> = {
  confirmed: "Confirmed",
  cancelled: "Dropped — nothing was written",
  expired: "Expired — ask again if it still stands",
  queued_for_review: "Sent to the admin review queue",
};

/** What the card is about, in one glyph, matched to the tier it belongs to. */
function CardIcon({ tool }: { tool: string }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "shrink-0",
  };
  // Outline's own document glyph, so a page change reads as a page change —
  // the same mark the Sources list uses (DESIGN.md §4).
  if (KB_TOOLS.has(tool)) {
    return (
      <svg {...common}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M9 13h6M9 17h4" />
      </svg>
    );
  }
  // A plug: this one leaves the building.
  if (WORLD_TOOLS.has(tool)) {
    return (
      <svg {...common}>
        <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v5" />
      </svg>
    );
  }
  // Sliders — the console's own vocabulary, for the console's own actions.
  if (ADMIN_TOOLS.has(tool)) {
    return (
      <svg {...common}>
        <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2" />
        <circle cx="16" cy="6" r="2" />
        <circle cx="10" cy="12" r="2" />
        <circle cx="16" cy="18" r="2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M12 5a3 3 0 0 0-6 0 3 3 0 0 0-1 5.8A3 3 0 0 0 8 16a3 3 0 0 0 4 2.8V5zM12 5a3 3 0 0 1 6 0 3 3 0 0 1 1 5.8A3 3 0 0 1 16 16a3 3 0 0 1-4 2.8V5z" />
    </svg>
  );
}

export function PendingActionCard({ card, compact = false }: { card: ChatCard; compact?: boolean }) {
  const [status, setStatus] = useState(card.status);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (EDITABLE[card.tool] ?? []).map((f) => [f.key, card.payload[f.key] == null ? "" : String(card.payload[f.key])]),
    ),
  );
  const [editing, setEditing] = useState(false);
  // Tracked separately from `editing`: collapsing the form must not silently
  // throw away what was typed into it.
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [divertedToReview, setDivertedToReview] = useState(false);

  const fields = EDITABLE[card.tool] ?? [];
  const isKbChange = KB_TOOLS.has(card.tool);
  const reachesWorld = WORLD_TOOLS.has(card.tool);
  const isOperator = ADMIN_TOOLS.has(card.tool);
  // A page change rendered in the compact panel with no diff to read (P8).
  // The widget's belt has no wiki tools, so this is only reachable by opening
  // an older conversation in the panel — but a Confirm button over a change
  // nobody can see is exactly what the surface rule exists to prevent, so it
  // is refused here too rather than trusted not to happen.
  const unreviewableHere = compact && isKbChange;

  async function decide(decision: "confirm" | "cancel" | "review") {
    setBusy(true);
    setError(null);
    try {
      const body =
        decision === "confirm" && edited
          ? {
              payload: {
                ...card.payload,
                // Blank an optional field back to null rather than "" — an
                // empty scope is "no scope", not a scope named nothing.
                ...Object.fromEntries(fields.map((f) => [f.key, draft[f.key]?.trim() ? draft[f.key].trim() : null])),
              },
            }
          : {};
      const res = await fetch(`/api/mort/actions/${card.id}/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!res.ok) {
        setError(json.error ?? `Failed (${res.status})`);
        // 409/410 mean the row moved on without us — reflect that, don't
        // leave a dead button on screen.
        if (res.status === 409 || res.status === 410) setStatus(res.status === 410 ? "expired" : "confirmed");
        return;
      }
      // "review" ends the CARD without a write, which is a cancellation as far
      // as mort_pending_actions is concerned — the proposal now lives in the
      // admin queue. The label below says which of the two actually happened.
      setStatus(decision === "confirm" ? "confirmed" : "cancelled");
      if (decision === "review") setDivertedToReview(true);
      setEditing(false);
      window.dispatchEvent(new Event(ACTION_DECIDED_EVENT));
    } catch {
      setError("Request failed — try again.");
    } finally {
      setBusy(false);
    }
  }

  const frame = `mt-3 rounded-md border bg-menu px-3 py-2 ${compact ? "text-[13px]" : "text-sm"}`;

  if (status !== "pending") {
    return (
      <div className={`${frame} border-divider text-text-3`}>
        <div className="flex items-center gap-2">
          <span className={status === "confirmed" ? "text-success" : "text-text-3"}>
            <CardIcon tool={card.tool} />
          </span>
          <span className="truncate">{card.preview}</span>
          <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide">
            {divertedToReview ? DECIDED.queued_for_review : DECIDED[status]}
          </span>
        </div>
      </div>
    );
  }

  if (unreviewableHere) {
    return (
      <div className={`${frame} border-divider`}>
        <div className="flex items-center gap-2 text-text-2">
          <span className="text-text-3">
            <CardIcon tool={card.tool} />
          </span>
          <span className="truncate">{card.preview}</span>
        </div>
        <p className="mt-1 text-[12px] text-text-3">
          Wiki changes are confirmed in the full app, where the before/after fits on screen.
        </p>
      </div>
    );
  }

  return (
    <div className={`${frame} border-accent/40`}>
      <div className="flex items-center gap-2 text-text">
        <span className="text-accent">
          <CardIcon tool={card.tool} />
        </span>
        <span className="font-medium">{titleOf(card)}</span>
      </div>

      {editing ? (
        <div className="mt-2 grid gap-1.5">
          {fields.map((f) => (
            <label key={f.key} className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-[12px] text-text-3">{f.label}</span>
              <input
                type={f.type ?? "text"}
                value={draft[f.key] ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => {
                  setDraft({ ...draft, [f.key]: e.target.value });
                  setEdited(true);
                }}
                className="flex-1 rounded border border-divider bg-bg px-2 py-1 text-[13px] text-text placeholder:text-text-3"
              />
            </label>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-text-2">
          {card.preview}
          {/* The preview is what Mort proposed; say so rather than showing a
              stale line as if it were what will be saved. */}
          {edited && <span className="ml-1.5 text-[11px] text-text-3">(edited — your changes will be saved)</span>}
        </p>
      )}

      {card.diff && card.diff.length > 0 && <RegionDiff lines={card.diff} />}

      {(card.warnings ?? []).map((w) => (
        <p key={w} className="mt-1.5 rounded border border-[color:var(--highlight)] bg-[color:var(--highlight)]/15 px-2 py-1 text-[12px] text-text-2">
          {w}
        </p>
      ))}

      {card.docUrl && (
        <a href={card.docUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-[12px] text-link underline">
          Open the page
        </a>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => decide("confirm")}
          disabled={busy}
          className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-success hover:bg-success/10 disabled:opacity-50"
        >
          {busy ? "…" : "Confirm"}
        </button>
        {fields.length > 0 && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            disabled={busy}
            className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-text-2 hover:bg-canvas-2 disabled:opacity-50"
          >
            {editing ? "Done editing" : "Edit"}
          </button>
        )}
        {isKbChange && (
          <button
            type="button"
            onClick={() => decide("review")}
            disabled={busy}
            className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-text-2 hover:bg-canvas-2 disabled:opacity-50"
            title="Put this in front of an admin instead of applying it now"
          >
            Send to review
          </button>
        )}
        <button
          type="button"
          onClick={() => decide("cancel")}
          disabled={busy}
          className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
        >
          Cancel
        </button>
        <span className="ml-auto text-[11px] text-text-3">
          {reachesWorld
            ? "This runs on connected equipment when you confirm"
            : isKbChange
              ? "The wiki is unchanged until you confirm"
              : isOperator
                ? operatorNote(card)
                : "Nothing is saved until you confirm"}
        </span>
      </div>
      {error && <p className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

/**
 * The before/after of Mort's region.
 *
 * Colour alone can't carry the meaning — colour-blind crew, a phone screen in
 * daylight at the back of a venue — so every line keeps its +/− gutter mark.
 */
function RegionDiff({ lines }: { lines: NonNullable<ChatCard["diff"]> }) {
  return (
    <pre className="mt-2 max-h-72 overflow-auto rounded border border-code-border bg-code p-2 text-[12px] leading-[1.5]">
      <code>
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.kind === "add"
                ? "text-success"
                : line.kind === "remove"
                  ? "text-danger line-through decoration-danger/40"
                  : "text-text-3"
            }
          >
            <span className="select-none opacity-60">
              {line.kind === "add" ? "+ " : line.kind === "remove" ? "\u2212 " : "\u00a0\u00a0"}
            </span>
            {line.text || "\u00a0"}
          </div>
        ))}
      </code>
    </pre>
  );
}
