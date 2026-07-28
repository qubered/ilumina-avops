import type { MortPendingAction } from "@/lib/mort-admin";

/**
 * Oversight of the confirm-then-live queue: what Mort has offered to remember,
 * who he offered it to, and what came of it. Read-only by design — cards are
 * answered in the conversation they were raised in, by the person whose name
 * ends up on the fact.
 */

const STATUS_STYLE: Record<string, string> = {
  pending: "text-accent",
  confirmed: "text-success",
  cancelled: "text-text-3",
  expired: "text-text-3",
};

const TOOL_LABEL: Record<string, string> = {
  save_fact: "fact",
  retire_fact: "retire",
  log_event: "event",
  apply_doc_edit: "page edit",
  create_doc: "new page",
  attach_source: "attach",
  mcp_call: "equipment",
  decide_review: "review",
  set_mode: "mode",
};

export function MortPendingActions({ actions }: { actions: MortPendingAction[] }) {
  return (
    <section className="mt-10">
      <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">Taught in chat</h2>
      <p className="mt-2 text-[13px] text-text-3">
        What Mort offered to remember from conversations. Confirmations happen in the chat —
        the crew member who told him is the one who approves it, and their name goes on the fact.
      </p>

      {actions.length === 0 ? (
        <p className="mt-3 text-sm text-text-3">Nothing taught in chat yet.</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {actions.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-md border border-divider bg-menu px-3 py-2 text-sm"
            >
              <span className="shrink-0 rounded border border-divider px-1.5 py-0.5 text-[11px] text-text-3">
                {TOOL_LABEL[a.tool] ?? a.tool}
              </span>
              <span className="truncate text-text-2">{a.preview}</span>
              <span className="ml-auto shrink-0 text-[11px] text-text-3">
                {a.createdAt.slice(0, 10)} · {a.decidedBy ?? a.userId}
              </span>
              <span className={`shrink-0 text-[11px] uppercase tracking-wide ${STATUS_STYLE[a.status] ?? ""}`}>
                {a.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
