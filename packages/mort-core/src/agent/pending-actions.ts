import { z } from "zod";
import { chatSourceId, recordChatProvenance } from "../kb/chat-write";
import { chatEventRowHash, chatEventSourceId, indexEvents } from "../kb/events-index";
import { getSelfUserId } from "../kb/outline";
import { decideReviewItem } from "../kb/review";
import { buildWriteDeps } from "../kb/write-deps";
import { writeMortRegion } from "../kb/writer";
import { getEffectiveMode, setMode } from "../memory/config";
import {
  appendJournal,
  getEventHashes,
  getFact,
  insertEvent,
  retireFact,
  saveFactSuperseding,
  upsertSource,
} from "../memory";
import { recordPendingResult, type PendingAction, type PendingTool } from "../memory/pending";
import { callMcpTool } from "../mcp/manager";
import { hashArgs } from "../tools/audit";
import type { ActorRole } from "../tools/policy";

/**
 * The executor half of confirm-then-live (MORT_V2_PLAN I.4).
 *
 * Everything here runs AFTER a session-authenticated human said yes. The model
 * supplies the payload and nothing else: the acting user is passed in by the
 * route from the session, never read out of the payload, so no amount of
 * clever phrasing in a conversation can put someone else's name on a fact.
 */

/** Who is doing this. Always derived from the session — never model-supplied. */
export type ActingUser = {
  id: string;
  email?: string | null;
  name?: string | null;
  role: ActorRole;
};

/** How a fact is attributed: the human's name on it, as v1's `approvedBy`. */
export function actorLabel(user: ActingUser): string {
  return user.email || user.name || user.id;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use an ISO date (yyyy-mm-dd)");

const tags = z.array(z.string().min(1)).max(12).optional();

export const saveFactPayload = z.object({
  factKey: z.string().min(1).max(120),
  value: z.string().min(1).max(500),
  scope: z.string().max(120).nullish(),
  effectiveFrom: isoDate.nullish(),
  note: z.string().max(1000).nullish(),
});

export const retireFactPayload = z.object({
  factId: z.number().int().positive(),
  /** Snapshot of what is being retired, so the card reads the same tomorrow. */
  factKey: z.string().nullish(),
  value: z.string().nullish(),
});

export const logEventPayload = z.object({
  actionText: z.string().min(1).max(1000),
  occurredOn: isoDate.nullish(),
  event: z.string().max(200).nullish(),
  zone: tags,
  system: tags,
  entities: tags,
});

/**
 * write:kb payloads (P3). The region body is carried in full rather than as a
 * patch: the card showed the user a diff computed from exactly this string, so
 * this string is what has to be written, whatever the page looks like by then.
 */
export const applyDocEditPayload = z.object({
  targetDocId: z.string().min(1),
  regionBody: z.string(),
  /** Snapshot of the page title so the card still reads the same tomorrow. */
  title: z.string().nullish(),
  rationale: z.string().max(1000).nullish(),
});

export const createDocPayload = z.object({
  title: z.string().min(1).max(200),
  collection: z.string().max(120).nullish(),
  regionBody: z.string().min(1),
  rationale: z.string().max(1000).nullish(),
});

export const attachSourcePayload = z.object({
  targetDocId: z.string().min(1),
  sourceId: z.string().min(1),
  title: z.string().nullish(),
  rationale: z.string().max(1000).nullish(),
});

/**
 * write:world payload (P5). The server and tool are recorded as the registry
 * knows them, not as the model spelled them: the belt resolves the namespaced
 * name it offered back to the real pair before parking the card, so what the
 * user confirms is what gets called.
 */
export const mcpCallPayload = z.object({
  server: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  /** What the tool says it does — shown on the card, since the crew won't know. */
  toolDescription: z.string().nullish(),
  /** Its definition changed since an admin reviewed the server. */
  drifted: z.boolean().nullish(),
});

/**
 * admin payloads (P8). Operator actions taken through a conversation.
 *
 * Both carry a snapshot of what the card described — the proposal's action and
 * title, the mode it is moving away from — so the card still reads the same
 * tomorrow, when the queue has moved on and the mode may have changed again.
 * The snapshot is display only: the executor re-reads the row and the current
 * mode, and decides against those.
 */
export const decideReviewPayload = z.object({
  reviewId: z.number().int().positive(),
  decision: z.enum(["approve", "reject"]),
  /** What the proposal was, as the card showed it. */
  action: z.string().max(80).nullish(),
  title: z.string().max(300).nullish(),
});

export const setModePayload = z.object({
  mode: z.enum(["off", "shadow", "live"]),
  /** The mode at the time the card was raised. */
  from: z.enum(["off", "shadow", "live"]).nullish(),
});

export const PAYLOAD_SCHEMAS = {
  save_fact: saveFactPayload,
  retire_fact: retireFactPayload,
  log_event: logEventPayload,
  apply_doc_edit: applyDocEditPayload,
  create_doc: createDocPayload,
  attach_source: attachSourcePayload,
  mcp_call: mcpCallPayload,
  decide_review: decideReviewPayload,
  set_mode: setModePayload,
} satisfies Record<PendingTool, z.ZodType>;

export type SaveFactPayload = z.infer<typeof saveFactPayload>;
export type RetireFactPayload = z.infer<typeof retireFactPayload>;
export type LogEventPayload = z.infer<typeof logEventPayload>;
export type ApplyDocEditPayload = z.infer<typeof applyDocEditPayload>;
export type CreateDocPayload = z.infer<typeof createDocPayload>;
export type AttachSourcePayload = z.infer<typeof attachSourcePayload>;
export type McpCallPayload = z.infer<typeof mcpCallPayload>;
export type DecideReviewPayload = z.infer<typeof decideReviewPayload>;
export type SetModePayload = z.infer<typeof setModePayload>;

/** Today, as an ISO date, in the venue's local reckoning. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Mort's own Outline user id, used to tell his edits from a human's. Never
 * fatal: without it `humanEditedSince` just stays false, and a warning we
 * couldn't compute is not a reason to refuse a write the user confirmed.
 */
const selfUserId = () => getSelfUserId().catch(() => null);

/**
 * The line the user is asked to confirm. This is the whole safety story of the
 * feature in one string, so it says exactly what will happen — including that
 * a new value REPLACES an existing one, which is the part people would
 * otherwise discover later.
 */
export function previewFor(tool: PendingTool, payload: Record<string, unknown>, replacing?: string | null): string {
  switch (tool) {
    case "save_fact": {
      const p = payload as SaveFactPayload;
      const scope = p.scope ? ` (${p.scope})` : "";
      const from = p.effectiveFrom ? `, effective ${p.effectiveFrom}` : "";
      const supersede = replacing ? ` — replaces “${replacing}”` : "";
      return `Remember: ${p.factKey}${scope} = ${p.value}${from}${supersede}`;
    }
    case "retire_fact": {
      const p = payload as RetireFactPayload;
      const what = p.factKey ? `${p.factKey}${p.value ? ` = ${p.value}` : ""}` : `fact #${p.factId}`;
      return `Forget: ${what} — no longer current`;
    }
    case "log_event": {
      const p = payload as LogEventPayload;
      const when = p.occurredOn ? ` on ${p.occurredOn}` : "";
      const ev = p.event ? ` [${p.event}]` : "";
      return `Log to the event log${ev}: ${p.actionText}${when}`;
    }
    // The KB previews say plainly which half of the page is in play, because
    // "edit this page" and "replace Mort's section of this page" are different
    // promises and only the second one is true.
    case "apply_doc_edit": {
      const p = payload as ApplyDocEditPayload;
      return `Update “${p.title ?? p.targetDocId}” — replacing Mort's section. Anything a human wrote outside it is untouched.`;
    }
    case "create_doc": {
      const p = payload as CreateDocPayload;
      return `Create a new page “${p.title}”${p.collection ? ` in ${p.collection}` : ""}`;
    }
    case "attach_source": {
      const p = payload as AttachSourcePayload;
      return `Attach ${p.sourceId} to “${p.title ?? p.targetDocId}”`;
    }
    // The only preview that names something outside Mort's systems, so it says
    // the arguments in full rather than summarising: whoever presses Confirm is
    // authorising an action on real equipment and has to see what it will do.
    case "mcp_call": {
      const p = payload as McpCallPayload;
      const args = Object.keys(p.args ?? {}).length ? ` with ${JSON.stringify(p.args)}` : " with no arguments";
      return `Run ${p.server}.${p.tool}${args}`;
    }
    // The operator previews name the CONSEQUENCE, not the switch: "approve
    // proposal #12" tells an admin nothing they can check, and "shadow mode"
    // means nothing to anyone who hasn't read the admin page this month.
    case "decide_review": {
      const p = payload as DecideReviewPayload;
      const what = p.title ?? p.action ?? `proposal #${p.reviewId}`;
      return p.decision === "approve"
        ? `Approve #${p.reviewId} — ${what} — and carry it out now`
        : `Reject #${p.reviewId} — ${what}. Nothing is written; the file stays in the library.`;
    }
    case "set_mode": {
      const p = payload as SetModePayload;
      const from = p.from && p.from !== p.mode ? ` (from ${p.from})` : "";
      return `Switch Mort to ${p.mode} mode${from} — ${MODE_CONSEQUENCE[p.mode]}`;
    }
  }
}

const MODE_CONSEQUENCE: Record<SetModePayload["mode"], string> = {
  off: "he stops filing arriving files entirely",
  shadow: "every KB write becomes a review-queue proposal, admins included",
  live: "he writes confident changes himself; unsure ones still go to review",
};

export type ExecutionResult = {
  /** One line for the conversation and the journal — what actually happened. */
  summary: string;
  factId?: number;
  supersededFactId?: number | null;
  sourceId?: string;
  rowHash?: string;
  /** The Outline page a write:kb action landed on. */
  docId?: string;
  /** Link straight to it, for the card's "done" state. */
  docUrl?: string;
};

export type ExecuteOptions = {
  /**
   * Re-index a page that was just written, so retrieval reflects the change on
   * the very next question. Supplied by the assistant, which owns
   * `kb_documents` and the Qdrant upsert; core stays out of the app's tables.
   *
   * Best-effort by design — a failed re-index is logged, never a failed write.
   * The page IS changed in Outline at that point, and the nightly sync
   * reconciles; throwing here would hand the card back to `pending` and invite
   * the user to write it twice.
   */
  onWritten?: (docId: string) => Promise<void>;
};

/**
 * Perform a confirmed action. Throws on failure so the caller can hand the card
 * back to `pending` — a half-done write must never read as confirmed.
 */
export async function executePendingAction(
  action: PendingAction,
  actor: ActingUser,
  opts: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const by = actorLabel(actor);
  const result = await runTool(action, actor, by);
  if (result.docId && opts.onWritten) {
    try {
      await opts.onWritten(result.docId);
    } catch (err) {
      console.error(`[mort] re-index after chat write to ${result.docId} failed:`, err);
    }
  }
  await recordPendingResult(action.id, { ...result, by, at: new Date().toISOString() });
  return result;
}

async function runTool(action: PendingAction, actor: ActingUser, by: string): Promise<ExecutionResult> {
  switch (action.tool) {
    case "save_fact": {
      const p = saveFactPayload.parse(action.payload);

      // Updating a fact does not overwrite it — the old row is superseded, so
      // "what did we think last month" stays answerable.
      const { id: factId, superseded, effectiveFrom } = await saveFactSuperseding({
        factKey: p.factKey,
        value: p.value,
        scope: p.scope ?? null,
        effectiveFrom: p.effectiveFrom ?? null,
        sourceTier: "chat",
        approvedBy: by,
        confidence: "approved",
        note: p.note ?? null,
        // Provenance (P2), all of it from the row and the session — never the
        // payload. This is what makes "Jayden told me, 23 July, in chat"
        // answerable later, with a link to the message that said it.
        taughtVia: "chat",
        conversationId: action.conversationId,
        messageId: action.messageId,
      });

      const scope = p.scope ? ` (${p.scope})` : "";
      const summary = superseded
        ? `Updated current state: ${p.factKey}${scope} = ${p.value} — was “${superseded.value}”. Effective ${effectiveFrom}, told by ${by}.`
        : `Saved to current state: ${p.factKey}${scope} = ${p.value}. Effective ${effectiveFrom}, told by ${by}.`;

      await appendJournal({
        action: "fact_saved",
        rationale: `${p.factKey} = ${p.value} (told by ${by}${superseded ? `, supersedes #${superseded.id}` : ""})`,
        confidence: 1,
        channel: "chat",
        actor: by,
        conversationId: action.conversationId,
      });
      return { summary, factId, supersededFactId: superseded?.id ?? null };
    }

    case "retire_fact": {
      const p = retireFactPayload.parse(action.payload);
      const fact = await getFact(p.factId);
      if (!fact) throw new Error(`fact #${p.factId} no longer exists`);
      const retired = await retireFact(p.factId);
      const label = `${fact.factKey}${fact.scope ? ` (${fact.scope})` : ""} = ${fact.value}`;
      const summary = retired
        ? `Retired from current state: ${label}. Retired by ${by}.`
        : `${label} was already retired — nothing to do.`;
      await appendJournal({
        action: "fact_retired",
        rationale: `${label} (retired by ${by})`,
        confidence: 1,
        channel: "chat",
        actor: by,
        conversationId: action.conversationId,
      });
      return { summary, factId: p.factId };
    }

    case "log_event": {
      const p = logEventPayload.parse(action.payload);
      // A chat-taught event is an ordinary event with a conversation for a
      // source, so it reconciles and indexes exactly like a spreadsheet row.
      const sourceId = chatEventSourceId(action.conversationId ?? actor.id);
      const occurredOn = p.occurredOn ?? today();
      const row = {
        rowHash: chatEventRowHash({ occurredOn, actionText: p.actionText }),
        event: p.event ?? null,
        occurredOn,
        zone: p.zone ?? [],
        system: p.system ?? [],
        entities: p.entities ?? [],
        actionText: p.actionText,
      };

      const before = await getEventHashes(sourceId);
      // Who reported it, and where — the event-log half of P2 provenance.
      await insertEvent(sourceId, row, { reportedBy: by, conversationId: action.conversationId });
      const known = before.includes(row.rowHash);
      // Pass every hash this source now has: prune reconciles the collection
      // rather than dropping the rows logged earlier in the conversation.
      await indexEvents(sourceId, known ? [] : [row], known ? before : [...before, row.rowHash], {
        reportedBy: by,
        conversationId: action.conversationId,
      });

      const summary = known
        ? `Already in the event log: ${p.actionText} (${occurredOn}).`
        : `Logged: ${p.actionText} (${occurredOn}). Reported by ${by}.`;
      await appendJournal({
        sourceId,
        action: "event_logged",
        rationale: `${p.actionText} on ${occurredOn} (reported by ${by})`,
        confidence: 1,
        channel: "chat",
        actor: by,
        conversationId: action.conversationId,
      });
      return { summary, sourceId, rowHash: row.rowHash };
    }

    // --- write:kb (P3) ----------------------------------------------------
    //
    // All three go through the v1 safe-write machinery unchanged: the region
    // splice happens inside withDocLock against a FRESH read, so a human edit
    // landing between the card being raised and confirmed is spliced around
    // rather than clobbered.

    case "apply_doc_edit": {
      const p = applyDocEditPayload.parse(action.payload);
      const sourceId = chatSourceId(action.conversationId);
      const label = p.title ?? p.targetDocId;
      const result = await writeMortRegion(p.targetDocId, p.regionBody, await selfUserId());
      await recordChatProvenance(sourceId, p.targetDocId, "updated");
      await appendJournal({
        sourceId,
        outlineDocumentId: p.targetDocId,
        action: "doc_updated",
        rationale: `${p.rationale ?? "corrected from chat"} (chat, confirmed by ${by})`,
        confidence: 1,
        channel: "chat",
        actor: by,
        conversationId: action.conversationId,
      });
      return {
        summary: result.changed
          ? `Updated “${label}” in the wiki. Confirmed by ${by}.`
          : `“${label}” already said exactly that — nothing changed.`,
        docId: p.targetDocId,
        sourceId,
      };
    }

    case "create_doc": {
      const p = createDocPayload.parse(action.payload);
      const sourceId = chatSourceId(action.conversationId);
      await upsertSource({
        sourceId,
        role: "truth",
        summary: `Told to Mort in chat${action.conversationId ? ` (conversation ${action.conversationId})` : ""}`,
      });
      // createDoc, not createDocument: it goes through the registry, so a page
      // whose semantic identity already exists is additively updated instead of
      // duplicated — the same rule ingestion follows, and the reason chat and
      // ingest keep ONE registry rather than two.
      // Provenance matters here as well as in the journal entry below:
      // buildWriteDeps journals its own writes, and defaulting to the ingest
      // channel would file a page written in conversation as if a file had
      // arrived (P2).
      const docId = await buildWriteDeps(await selfUserId(), {
        channel: "chat",
        actor: by,
        conversationId: action.conversationId,
      }).createDoc({
        title: p.title,
        collection: p.collection ?? null,
        regionBody: p.regionBody,
        sourceId,
      });
      await appendJournal({
        sourceId,
        outlineDocumentId: docId,
        action: "doc_created",
        rationale: `${p.rationale ?? "written from chat"} (chat, confirmed by ${by})`,
        confidence: 1,
        channel: "chat",
        actor: by,
        conversationId: action.conversationId,
      });
      return { summary: `Created “${p.title}” in the wiki. Confirmed by ${by}.`, docId, sourceId };
    }

    case "attach_source": {
      const p = attachSourcePayload.parse(action.payload);
      const deps = buildWriteDeps(await selfUserId(), {
        channel: "chat",
        actor: by,
        conversationId: action.conversationId,
      });
      if (!deps.attachFile) throw new Error("attach executor unavailable");
      await deps.attachFile(p.targetDocId, p.sourceId);
      await appendJournal({
        sourceId: p.sourceId,
        outlineDocumentId: p.targetDocId,
        action: "doc_attached",
        rationale: `${p.rationale ?? "attached from chat"} (chat, confirmed by ${by})`,
        confidence: 1,
        channel: "chat",
        actor: by,
        conversationId: action.conversationId,
      });
      return {
        summary: `Attached ${p.sourceId} to “${p.title ?? p.targetDocId}”. Confirmed by ${by}.`,
        docId: p.targetDocId,
        sourceId: p.sourceId,
      };
    }

    // --- write:world (P5) -------------------------------------------------
    //
    // The one executor that reaches outside Mort's own systems. Note what it
    // does NOT do on a failure: throw. A KB write that fails should hand its
    // card back to `pending` so the user can try again, but an MCP call may
    // well have happened before the error — retrying it is not obviously safe,
    // and a card that reads as untouched would invite exactly that. So the
    // attempt is recorded, the failure is reported, and the card stays decided.
    case "mcp_call": {
      const p = mcpCallPayload.parse(action.payload);
      const started = Date.now();
      const result = await callMcpTool(p.server, p.tool, p.args ?? {});
      const latencyMs = Date.now() - started;

      await appendJournal({
        action: "mcp_call",
        rationale: `${p.server}.${p.tool} ${result.ok ? "ok" : "failed"} (confirmed by ${by}, ${latencyMs}ms)`,
        confidence: 1,
        channel: "chat",
        actor: by,
        conversationId: action.conversationId,
        // The arguments themselves stay on the pending row the user confirmed;
        // the journal keeps a digest so "was this the same call as last time?"
        // is answerable without the audit trail accumulating door codes.
        details: {
          server: p.server,
          tool: p.tool,
          argsHash: hashArgs(p.args ?? {}),
          outcome: result.ok ? "ok" : "error",
          latencyMs,
        },
      });

      const label = `${p.server}.${p.tool}`;
      return {
        summary: result.ok
          ? `Ran ${label} — ${result.text || "no output"}. Confirmed by ${by}.`
          : `${label} failed: ${result.text} Nothing else was attempted.`,
      };
    }

    // --- admin (P8) -------------------------------------------------------
    //
    // The console's two operations, reached through a conversation. Note that
    // neither trusts the snapshot on the card: `decideReviewItem` re-reads the
    // queue row and refuses one that has already been decided, and `setMode`
    // reads the mode back rather than assuming the card's `from` still holds.
    // A card can sit on someone's screen for a day.

    case "decide_review": {
      const p = decideReviewPayload.parse(action.payload);
      const outcome = await decideReviewItem(p.reviewId, p.decision, {
        decidedBy: by,
        channel: "chat",
        conversationId: action.conversationId,
      });
      if (!outcome.ok) {
        // Throwing hands the card back to `pending`, so the two failures are
        // told apart by whether trying again could work. An executor that fell
        // over left the proposal queued — that IS retryable. A proposal that is
        // gone, or that somebody else already answered, is not: handing that
        // card back would just invite an admin to decide it a second time.
        if (outcome.reason === "execute_failed") throw new Error(outcome.message);
        return { summary: outcome.message };
      }
      if (outcome.status === "rejected") {
        return {
          summary: `Rejected proposal #${p.reviewId}${p.title ? ` — ${p.title}` : ""}. Nothing was written; the file stays in the library. Decided by ${by}.`,
        };
      }
      return {
        summary: `Approved proposal #${p.reviewId}${p.title ? ` — ${p.title}` : ""}: ${outcome.executed} in the wiki. Decided by ${by}.`,
        docId: outcome.docId || undefined,
        docUrl: outcome.docUrl ?? undefined,
      };
    }

    case "set_mode": {
      const p = setModePayload.parse(action.payload);
      const before = await getEffectiveMode();
      if (before === p.mode) {
        return { summary: `Mort was already in ${p.mode} mode — nothing changed.` };
      }
      await setMode(p.mode);
      await appendJournal({
        action: `mode:${p.mode}`,
        rationale: `authoring mode ${before} → ${p.mode}, from chat (confirmed by ${by})`,
        confidence: 1,
        channel: "chat",
        actor: by,
        conversationId: action.conversationId,
      });
      console.log(`[mort] mode set to ${p.mode} from chat by ${by}`);
      return { summary: `Mort is now in ${p.mode} mode (was ${before}) — ${MODE_CONSEQUENCE[p.mode]}. Switched by ${by}.` };
    }
  }
}
