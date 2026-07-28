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
};

const DECIDED: Record<string, string> = {
  confirmed: "Confirmed",
  cancelled: "Dropped — nothing was written",
  expired: "Expired — ask again if it still stands",
};

function BrainIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
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

  const fields = EDITABLE[card.tool] ?? [];

  async function decide(decision: "confirm" | "cancel") {
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
      setStatus(decision === "confirm" ? "confirmed" : "cancelled");
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
            <BrainIcon />
          </span>
          <span className="truncate">{card.preview}</span>
          <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide">{DECIDED[status]}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`${frame} border-accent/40`}>
      <div className="flex items-center gap-2 text-text">
        <span className="text-accent">
          <BrainIcon />
        </span>
        <span className="font-medium">{TITLES[card.tool] ?? "Confirm?"}</span>
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

      <div className="mt-2.5 flex items-center gap-1.5">
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
        <button
          type="button"
          onClick={() => decide("cancel")}
          disabled={busy}
          className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
        >
          Cancel
        </button>
        <span className="ml-auto text-[11px] text-text-3">Nothing is saved until you confirm</span>
      </div>
      {error && <p className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
