import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { executePendingAction, PAYLOAD_SCHEMAS, previewFor } from "@mort/core/agent/pending-actions";
import { findCurrentFactByKey } from "@mort/core/memory";
import { claimPendingAction, releasePendingAction, updatePendingPayload } from "@mort/core/memory/pending";
import { actingUserFromSession } from "@/lib/acting-user";
import { conversations, db, messages } from "@/lib/db";
import { guardDecision } from "@/lib/mort-actions";
import { syncDocumentById } from "@/lib/rag/sync";

/**
 * Confirm a card: the moment a proposal becomes a write (MORT_V2_PLAN I.4).
 *
 * The acting user is read from the SESSION and nowhere else — the body may
 * carry an edited payload (the card's Edit button) but never who is approving
 * it. That split is what keeps a fact's attribution meaningful.
 */

const bodySchema = z.object({ payload: z.record(z.string(), z.unknown()).optional() });

export async function POST(req: Request, ctx: RouteContext<"/api/mort/actions/[id]/confirm">) {
  const guard = await guardDecision(ctx.params);
  if (!guard.ok) return guard.response;
  const { session } = guard;
  let action = guard.action;

  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  // Edited before confirming: re-validate against the tool's own schema and
  // re-render the preview, so what's stored is what the user actually agreed to.
  if (body.data.payload) {
    const schema = PAYLOAD_SCHEMAS[action.tool];
    const payload = schema.safeParse(body.data.payload);
    if (!payload.success) {
      return NextResponse.json({ error: "That edit doesn't fit the action" }, { status: 400 });
    }
    const edited = payload.data as Record<string, unknown>;
    const replacing =
      action.tool === "save_fact"
        ? await findCurrentFactByKey(String(edited.factKey), (edited.scope as string) ?? null)
            .then((f) => f?.value ?? null)
            .catch(() => null)
        : null;
    const updated = await updatePendingPayload(action.id, edited, previewFor(action.tool, edited, replacing));
    if (!updated) return NextResponse.json({ error: "That confirmation was already decided." }, { status: 409 });
    action = updated;
  }

  // Claim first: whoever wins this CAS owns the write, so a double-click or a
  // race with the plain-text "yes" path can't execute it twice.
  const claimed = await claimPendingAction(action.id, "confirmed", session.user.id);
  if (!claimed) return NextResponse.json({ error: "That confirmation was already decided." }, { status: 409 });

  let summary: string;
  try {
    // onWritten re-indexes a page the moment it changes, so the correction is
    // searchable in the very next answer instead of at the nightly sync. Core
    // owns Outline and Qdrant; the assistant owns kb_documents — this hook is
    // where that line is crossed, explicitly.
    ({ summary } = await executePendingAction(claimed, actingUserFromSession(session), {
      onWritten: (docId) => syncDocumentById(docId),
    }));
  } catch (err) {
    // Nothing landed — put the card back rather than leaving it reading as done.
    await releasePendingAction(action.id).catch(() => {});
    console.error(`[mort-actions] execute ${action.id} failed:`, err);
    return NextResponse.json({ error: "The write failed. Nothing was saved — try again shortly." }, { status: 500 });
  }

  // Append the outcome to the conversation so the crew (and Mort's next turn)
  // can see what was actually written, not just that a button was pressed.
  let messageId: string | null = null;
  if (claimed.conversationId) {
    const [row] = await db
      .insert(messages)
      .values({ conversationId: claimed.conversationId, role: "assistant", content: summary })
      .returning({ id: messages.id });
    messageId = row?.id ?? null;
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, claimed.conversationId));
  }

  return NextResponse.json({ id: action.id, status: "confirmed", summary, messageId });
}
