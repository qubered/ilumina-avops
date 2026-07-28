import { z } from "zod";
import { chatEventRowHash, chatEventSourceId, indexEvents } from "../kb/events-index";
import {
  appendJournal,
  getEventHashes,
  getFact,
  insertEvent,
  retireFact,
  saveFactSuperseding,
} from "../memory";
import { recordPendingResult, type PendingAction, type PendingTool } from "../memory/pending";
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

export const PAYLOAD_SCHEMAS = {
  save_fact: saveFactPayload,
  retire_fact: retireFactPayload,
  log_event: logEventPayload,
} satisfies Record<PendingTool, z.ZodType>;

export type SaveFactPayload = z.infer<typeof saveFactPayload>;
export type RetireFactPayload = z.infer<typeof retireFactPayload>;
export type LogEventPayload = z.infer<typeof logEventPayload>;

/** Today, as an ISO date, in the venue's local reckoning. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  }
}

export type ExecutionResult = {
  /** One line for the conversation and the journal — what actually happened. */
  summary: string;
  factId?: number;
  supersededFactId?: number | null;
  sourceId?: string;
  rowHash?: string;
};

/**
 * Perform a confirmed action. Throws on failure so the caller can hand the card
 * back to `pending` — a half-done write must never read as confirmed.
 */
export async function executePendingAction(action: PendingAction, actor: ActingUser): Promise<ExecutionResult> {
  const by = actorLabel(actor);
  const result = await runTool(action, actor, by);
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
      });

      const scope = p.scope ? ` (${p.scope})` : "";
      const summary = superseded
        ? `Updated current state: ${p.factKey}${scope} = ${p.value} — was “${superseded.value}”. Effective ${effectiveFrom}, told by ${by}.`
        : `Saved to current state: ${p.factKey}${scope} = ${p.value}. Effective ${effectiveFrom}, told by ${by}.`;

      await appendJournal({
        action: "fact_saved",
        rationale: `${p.factKey} = ${p.value} (chat, told by ${by}${superseded ? `, supersedes #${superseded.id}` : ""})`,
        confidence: 1,
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
        rationale: `${label} (chat, retired by ${by})`,
        confidence: 1,
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
      await insertEvent(sourceId, row);
      const known = before.includes(row.rowHash);
      // Pass every hash this source now has: prune reconciles the collection
      // rather than dropping the rows logged earlier in the conversation.
      await indexEvents(sourceId, known ? [] : [row], known ? before : [...before, row.rowHash]);

      const summary = known
        ? `Already in the event log: ${p.actionText} (${occurredOn}).`
        : `Logged: ${p.actionText} (${occurredOn}). Reported by ${by}.`;
      await appendJournal({
        sourceId,
        action: "event_logged",
        rationale: `${p.actionText} on ${occurredOn} (chat, reported by ${by})`,
        confidence: 1,
      });
      return { summary, sourceId, rowHash: row.rowHash };
    }
  }
}
