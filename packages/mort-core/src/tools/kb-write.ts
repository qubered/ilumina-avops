import { tool } from "ai";
import { z } from "zod";
import { placeDumpPage, splitDump } from "../agent/dump";
import {
  chatSourceId,
  executePendingAction,
  previewDocEdit,
  type DocEditPreview,
  type ExecuteOptions,
} from "../kb/chat-write";
import { renderMetadataHeader, restampHeader } from "../kb/mort-header";
import { documentUrl, getDocumentOrNull } from "../kb/outline";
import { enqueueReview } from "../memory";
import {
  claimPendingAction,
  countPendingCreatedToday,
  createPendingAction,
  expireStalePendingActions,
  getPendingAction,
  listPendingActions,
  PENDING_DAILY_CAP,
  releasePendingAction,
  type PendingAction,
  type PendingTool,
} from "../memory/pending";
import { resolveKbWriteRoute, type ActingUser } from "./policy";

/**
 * Mort's write tool belt for chat (MORT_V2_PLAN §I.3 `write:kb` + `write:memory`,
 * §I.4 confirm-then-live).
 *
 * Two rules hold for every tool in here, and they are what make giving a chat
 * agent write access defensible:
 *
 *  1. **No tool writes.** Each one parks a payload in `mort_pending_actions` and
 *     returns a preview. The write happens in the confirm route, run by a named
 *     human, with attribution taken from that human's session.
 *  2. **Policy is resolved here, not in the prompt.** Role, mode, the confidence
 *     gate and the invented-target guard are checked by `resolveKbWriteRoute`
 *     before a payload is parked; a member's edit becomes a review-queue
 *     proposal no matter how the conversation went.
 */

export type ToolContext = {
  user: ActingUser;
  conversationId: string | null;
  /**
   * Outline doc ids Mort has actually seen this turn (populated by kb_search /
   * kb_get_doc). The v1 "never act on an invented doc id" guard, moved into the
   * tool layer where it now protects chat as well as ingestion.
   */
  seen: Set<string>;
  /** Re-index hook handed to the executor; see chat-write ExecuteOptions. */
  onWritten?: ExecuteOptions["onWritten"];
};

/** What a card needs to render, whatever the tool that produced it. */
export type PendingCard = {
  status: "pending_confirmation";
  pendingId: string;
  tool: PendingTool;
  title: string;
  /** Human-readable body of the card (markdown). */
  preview: string;
  /** Present for doc edits. */
  diff?: DocEditPreview["diff"];
  docUrl?: string;
  warnings: string[];
  /** What Mort should say while the card sits there. */
  note: string;
};

type ToolReply =
  | PendingCard
  | { status: "queued_for_review"; reason: string; note: string }
  | { status: "blocked"; reason: string }
  | { status: "error"; error: string }
  | { status: "applied"; summary: string; docUrl?: string };

const blocked = (reason: string): ToolReply => ({ status: "blocked", reason });
const failed = (error: string): ToolReply => ({ status: "error", error });

/**
 * Guard against a runaway conversation filling the queue with executable
 * payloads (MORT_V2_PLAN §IV rate limits).
 */
async function capReached(userId: string): Promise<boolean> {
  return (await countPendingCreatedToday(userId)) >= PENDING_DAILY_CAP;
}

const CAP_MESSAGE =
  `That's ${PENDING_DAILY_CAP} proposals from you today, which is the daily cap. ` +
  `Confirm or cancel some of the ones already waiting and we'll keep going.`;

async function park(
  ctx: ToolContext,
  tool: PendingTool,
  payload: Record<string, unknown>,
  card: Omit<PendingCard, "status" | "pendingId" | "tool" | "note">,
): Promise<ToolReply> {
  if (await capReached(ctx.user.id)) return blocked(CAP_MESSAGE);
  const action = await createPendingAction({
    conversationId: ctx.conversationId,
    userId: ctx.user.id,
    tool,
    payload,
    preview: card.preview,
  });
  return {
    status: "pending_confirmation",
    pendingId: action.id,
    tool,
    ...card,
    note:
      "Nothing has been written yet. Tell the user what you're proposing in one line and let them use the " +
      "card's Confirm button — or, if they say yes in plain text, call apply_pending with this pendingId.",
  };
}

// --- write:kb ---------------------------------------------------------------

const REGION_BODY_HELP =
  "The FULL new content of Mort's region on that page, in markdown. This REPLACES the region wholesale, " +
  "so include everything that should remain — read the page first (kb_get_doc) and edit its current region " +
  "rather than writing a fragment. Content outside Mort's markers is a human's and is never touched.";

export function buildKbWriteTools(ctx: ToolContext) {
  return {
    propose_doc_edit: tool({
      description:
        "Correct or extend an existing KB page. Use this when the user says a page is wrong or out of date " +
        "(\"that patching page is wrong, it's actually X\"). Shows the user a before/after diff of Mort's " +
        "region and writes nothing until they confirm. Read the page with kb_get_doc first.",
      inputSchema: z.object({
        targetDocId: z
          .string()
          .describe("The Outline document id — MUST come from a kb_search or kb_get_doc result, never invented."),
        regionBody: z.string().describe(REGION_BODY_HELP),
        rationale: z.string().describe("One line: what is changing and why the user's correction is right."),
        confidence: z.number().min(0).max(1).describe("How sure you are this edit is correct and well-targeted."),
      }),
      execute: (input) => proposeDocEdit(ctx, input),
    }),

    create_doc: tool({
      description:
        "Create a NEW KB page. Only when kb_search has shown there is no existing page to extend — updating " +
        "an existing page always beats making a near-duplicate. Writes nothing until the user confirms.",
      inputSchema: z.object({
        title: z.string().describe("The page title, in the KB's style (specific, not a sentence)."),
        collection: z
          .string()
          .nullable()
          .describe("Outline collection it belongs in, or null to use the default."),
        body: z
          .string()
          .describe(
            "The page body in markdown, following KB conventions: short intro, then ## headings, numbered steps " +
              "where the source gives steps. Do NOT write the metadata header — that is added for you.",
          ),
        zone: z.array(z.string()).describe("Venue zones this concerns (e.g. Main Stage). Empty if none."),
        system: z.array(z.string()).describe("Systems this concerns (Video, Audio, Lighting, Network…)."),
        entities: z.array(z.string()).describe("Specific gear/rooms named in the content."),
        docType: z.string().nullable().describe("How-to, Reference, Policy, Troubleshooting… or null."),
        rationale: z.string().describe("One line: why this deserves its own page rather than an edit."),
        confidence: z.number().min(0).max(1),
      }),
      execute: async (input): Promise<ToolReply> => {
        try {
          const route = await resolveKbWriteRoute(ctx.user, { confidence: input.confidence });
          const regionBody = buildRegionBody(input, ctx.conversationId);

          if (route.route === "blocked") return blocked(route.reason);
          if (route.route === "review") {
            return queueForReview(ctx, {
              action: "CREATE",
              targetDocId: null,
              rationale: input.rationale,
              payload: { title: input.title, collection: input.collection, regionBody },
              reason: route.reason,
            });
          }

          return park(
            ctx,
            "create_doc",
            { title: input.title, collection: input.collection, regionBody, rationale: input.rationale },
            {
              title: input.title,
              preview: `**New page — ${input.title}**${input.collection ? ` (in ${input.collection})` : ""}\n\n${regionBody}`,
              warnings: [],
            },
          );
        } catch (err) {
          return failed(message(err));
        }
      },
    }),

    attach_source: tool({
      description:
        "Attach a file Mort already holds in his library (see mort_memory) to a KB page, listed under the " +
        "page's Files section. Writes nothing until the user confirms.",
      inputSchema: z.object({
        targetDocId: z.string().describe("The Outline document id — from a kb_search or kb_get_doc result."),
        sourceId: z.string().describe("The library source id of the file to attach (exactly as mort_memory gave it)."),
        rationale: z.string().describe("One line: why that file belongs on that page."),
      }),
      execute: async ({ targetDocId, sourceId, rationale }): Promise<ToolReply> => {
        try {
          const inventedTarget = !ctx.seen.has(targetDocId);
          const doc = await getDocumentOrNull(targetDocId);
          if (!doc) return failed(`No Outline document with id '${targetDocId}'.`);

          const route = await resolveKbWriteRoute(ctx.user, { inventedTarget });
          if (route.route === "blocked") return blocked(route.reason);
          if (route.route === "review") {
            return queueForReview(ctx, {
              action: "ATTACH",
              targetDocId: inventedTarget ? null : targetDocId,
              sourceId,
              rationale,
              reason: route.reason,
            });
          }

          return park(
            ctx,
            "attach_source",
            { targetDocId, sourceId, title: doc.title, rationale },
            {
              title: doc.title,
              preview: `Attach **${sourceId}** to **${doc.title}**.\n\n${rationale}`,
              docUrl: documentUrl(doc),
              warnings: [],
            },
          );
        } catch (err) {
          return failed(message(err));
        }
      },
    }),

    // --- write:memory -----------------------------------------------------

    save_fact: tool({
      description:
        "Record a current-state fact the user has just told you — a deliberate decision about what is true NOW " +
        "(\"the LED wall is at 6m from today\"). Restate it back and let them confirm; nothing is saved until they do. " +
        "Not for what the crew DID (that's log_event) and not for documented procedure (that's a KB page).",
      inputSchema: z.object({
        factKey: z.string().describe("Short stable key, e.g. 'LED wall height'."),
        value: z.string().describe("The value now in force, e.g. '6m'."),
        scope: z.string().nullable().describe("Where it applies, e.g. 'Main Stage'. Null if venue-wide."),
        effectiveFrom: z
          .string()
          .nullable()
          .describe("ISO date (yyyy-mm-dd) it took effect, or null for 'from now'."),
        note: z.string().nullable().describe("Any qualifier worth keeping with the fact."),
      }),
      execute: async (input): Promise<ToolReply> => {
        try {
          return await park(ctx, "save_fact", { ...input }, {
            title: input.factKey,
            preview:
              `**${input.factKey} = ${input.value}**` +
              (input.scope ? `\n\nScope: ${input.scope}` : "") +
              (input.effectiveFrom ? `\n\nEffective from: ${input.effectiveFrom}` : "") +
              (input.note ? `\n\n${input.note}` : ""),
            warnings: [],
          });
        } catch (err) {
          return failed(message(err));
        }
      },
    }),

    log_event: tool({
      description:
        "Record something the crew actually DID, as a dated observation in the event log " +
        "(\"ran SDI under the floor on Tuesday\"). Nothing is logged until the user confirms.",
      inputSchema: z.object({
        actionText: z.string().describe("What was done, in one line, in the crew's own words."),
        occurredOn: z.string().nullable().describe("ISO date (yyyy-mm-dd) it happened, or null if unknown."),
        event: z.string().nullable().describe("The show/job it was part of, if named."),
        zone: z.array(z.string()),
        system: z.array(z.string()),
        entities: z.array(z.string()),
      }),
      execute: async (input): Promise<ToolReply> => {
        try {
          return await park(ctx, "log_event", { ...input }, {
            title: input.actionText.slice(0, 80),
            preview:
              `**${input.actionText}**` +
              (input.occurredOn ? `\n\nWhen: ${input.occurredOn}` : "") +
              (input.event ? `\n\nEvent: ${input.event}` : "") +
              ([...input.zone, ...input.system, ...input.entities].length
                ? `\n\nTags: ${[...input.zone, ...input.system, ...input.entities].join(", ")}`
                : ""),
            warnings: input.occurredOn ? [] : ["No date given — ask when it happened if it matters."],
          });
        } catch (err) {
          return failed(message(err));
        }
      },
    }),

    // --- brain dump -------------------------------------------------------

    brain_dump: tool({
      description:
        "Turn a wall of unstructured information the user has just pasted or dictated (\"here's everything about " +
        "the new comms setup\") into properly formatted KB pages, facts and event-log entries. Use this instead of " +
        "answering when a message is long and informational rather than a question. Mort finds the existing pages " +
        "first and prefers extending them over making duplicates. Writes nothing — it returns one confirmation " +
        "card per resulting page, fact and event, each confirmed separately.",
      inputSchema: z.object({
        text: z
          .string()
          .describe("The user's dump, verbatim. Do not summarise or reformat it — the splitter needs the original."),
      }),
      execute: async ({ text }): Promise<Record<string, unknown>> => {
        try {
          return await runBrainDump(ctx, text);
        } catch (err) {
          return { status: "error", error: message(err) };
        }
      },
    }),

    // --- confirmation & visibility ----------------------------------------

    apply_doc_edit: tool({
      description:
        "Apply a KB change (a doc edit, a new page, an attachment) the user has just agreed to in plain text " +
        "(\"yes\", \"go on then\") rather than by clicking Confirm. Pass the pendingId you were given when you " +
        "proposed it. Only works for a proposal made to THIS user in THIS conversation, and only for KB changes — " +
        "use confirm_pending for a fact or an event.",
      inputSchema: z.object({
        pendingId: z.string().describe("The pendingId from the KB proposal the user just agreed to."),
      }),
      execute: ({ pendingId }) => applyConfirmed(ctx, pendingId, "kb"),
    }),

    confirm_pending: tool({
      description:
        "Save a fact or an event the user has just agreed to in plain text rather than by clicking Confirm. " +
        "Pass the pendingId you were given when you proposed it.",
      inputSchema: z.object({
        pendingId: z.string().describe("The pendingId from the proposal the user just agreed to."),
      }),
      execute: ({ pendingId }) => applyConfirmed(ctx, pendingId, "memory"),
    }),

    list_pending: tool({
      description:
        "List the proposals this user has waiting on a confirmation. Use when they ask what's outstanding, or " +
        "when they say 'yes' without it being clear what to.",
      inputSchema: z.object({}),
      execute: async (): Promise<Record<string, unknown>> => {
        await expireStalePendingActions();
        const rows = await listPendingActions({ userId: ctx.user.id });
        if (!rows.length) return { note: "Nothing waiting on a confirmation." };
        return {
          pending: rows.map((r) => ({
            pendingId: r.id,
            tool: r.tool,
            preview: r.preview,
            proposedAt: r.createdAt,
            thisConversation: r.conversationId === ctx.conversationId,
          })),
        };
      },
    }),
  };
}

/**
 * Propose an edit to an existing page: the diff-card path. Extracted from the
 * tool so the brain dump's UPDATE_ADDITIVE branch goes through EXACTLY this —
 * same policy check, same malformed-region check, same diff — rather than a
 * parallel implementation that drifts.
 */
async function proposeDocEdit(
  ctx: ToolContext,
  input: { targetDocId: string; regionBody: string; rationale: string; confidence: number },
): Promise<ToolReply> {
  const { targetDocId, regionBody, rationale, confidence } = input;
  try {
    const inventedTarget = !ctx.seen.has(targetDocId);
    const preview = await previewDocEdit(targetDocId, regionBody);
    if (!preview) return failed(`No Outline document with id '${targetDocId}'. Search for the page first.`);

    // A stray marker means we cannot tell where Mort's content ends, so the
    // safe-write invariant no longer holds — a human has to look. This check
    // comes before the policy routing because it is not a policy question:
    // nothing may auto-splice this page, whoever is asking.
    if (preview.malformed) {
      return queueForReview(ctx, {
        action: "UPDATE_ADDITIVE",
        targetDocId,
        rationale: `${rationale} [page has a malformed Mort region (stray marker) — needs a human to untangle before any automated write]`,
        payload: { title: preview.title, regionBody },
        reason: `"${preview.title}" has a broken Mort marker, so I won't splice it automatically — sent to review.`,
      });
    }

    if (!preview.changed) {
      return failed(`"${preview.title}" already says exactly that — nothing to change.`);
    }

    const route = await resolveKbWriteRoute(ctx.user, { confidence, inventedTarget });
    if (route.route === "blocked") return blocked(route.reason);

    if (route.route === "review") {
      return queueForReview(ctx, {
        action: "UPDATE_ADDITIVE",
        targetDocId: inventedTarget ? null : targetDocId,
        rationale: inventedTarget
          ? `${rationale} [target '${targetDocId}' was not among the KB search results — Mort guessed it]`
          : rationale,
        payload: { title: preview.title, regionBody },
        reason: route.reason,
      });
    }

    return park(
      ctx,
      "apply_doc_edit",
      { targetDocId, regionBody, rationale, title: preview.title },
      {
        title: preview.title,
        preview: previewText(preview),
        diff: preview.diff,
        docUrl: preview.url,
        warnings: editWarnings(preview),
      },
    );
  } catch (err) {
    return failed(message(err));
  }
}

// --- brain dump -------------------------------------------------------------

/**
 * Pages a single dump may fan out into. A dump that genuinely covers more than
 * this is a document, not a message — and eight cards is already more than
 * anyone will read carefully, which is the number that matters.
 */
const MAX_DUMP_PAGES = 8;

async function runBrainDump(ctx: ToolContext, text: string): Promise<Record<string, unknown>> {
  const spent = await countPendingCreatedToday(ctx.user.id);
  let budget = PENDING_DAILY_CAP - spent;
  if (budget <= 0) return { status: "blocked", reason: CAP_MESSAGE };

  const { split } = await splitDump(text);
  const sourceId = chatSourceId(ctx.conversationId);
  const dropped: string[] = [];

  const pages = split.pages.slice(0, MAX_DUMP_PAGES);
  if (split.pages.length > pages.length) {
    dropped.push(`${split.pages.length - pages.length} further page(s) — the dump covers more than one message should`);
  }

  const cards: unknown[] = [];

  for (const page of pages) {
    if (budget <= 0) {
      dropped.push(`${page.title} (daily proposal cap reached)`);
      continue;
    }
    const { placement } = await placeDumpPage(page, sourceId);

    // Same guard as the ingest turn: the model may only target a page it was
    // actually shown. A plausible-looking id it invented would land the crew's
    // comms notes on some unrelated page.
    const candidateIds = new Set(placement.candidates.map((c) => c.docId));
    const inventedTarget =
      placement.action === "UPDATE_ADDITIVE" &&
      (!placement.targetDocId || !candidateIds.has(placement.targetDocId));

    const regionBody = restampHeader(placement.regionBody, {
      zone: page.zone,
      system: page.system,
      docType: page.docType,
      entities: page.entities,
      sourceFiles: [sourceId],
      sourceTier: "word",
    });

    if (placement.action === "UPDATE_ADDITIVE" && !inventedTarget) {
      // Route through the same tool the model would have called by hand, so the
      // policy check, the malformed-region check and the diff are identical.
      ctx.seen.add(placement.targetDocId!);
      cards.push(
        await proposeDocEdit(ctx, {
          targetDocId: placement.targetDocId!,
          regionBody,
          rationale: placement.rationale,
          confidence: placement.confidence,
        }),
      );
    } else {
      const route = await resolveKbWriteRoute(ctx.user, {
        confidence: placement.confidence,
        inventedTarget,
      });
      if (route.route === "blocked") return { status: "blocked", reason: route.reason };
      if (route.route === "review") {
        cards.push(
          await queueForReview(ctx, {
            action: "CREATE",
            targetDocId: null,
            rationale: placement.rationale,
            payload: { title: placement.title, collection: placement.collection, regionBody },
            reason: route.reason,
          }),
        );
      } else {
        cards.push(
          await park(
            ctx,
            "create_doc",
            {
              title: placement.title,
              collection: placement.collection,
              regionBody,
              rationale: placement.rationale,
            },
            {
              title: placement.title,
              preview: `**New page — ${placement.title}**${placement.collection ? ` (in ${placement.collection})` : ""}\n\n${regionBody}`,
              warnings: [],
            },
          ),
        );
      }
    }
    budget--;
  }

  // Fact- and event-shaped statements are offered as facts and events rather
  // than buried in a page's prose — one dump fans out into pages AND memory.
  const facts: unknown[] = [];
  for (const f of split.facts) {
    if (budget <= 0) {
      dropped.push(`fact "${f.factKey}" (daily proposal cap reached)`);
      continue;
    }
    budget--;
    facts.push(
      await park(ctx, "save_fact", { ...f }, {
        title: f.factKey,
        preview: `**${f.factKey} = ${f.value}**${f.scope ? `\n\nScope: ${f.scope}` : ""}${f.effectiveFrom ? `\n\nEffective from: ${f.effectiveFrom}` : ""}`,
        warnings: [],
      }),
    );
  }

  const events: unknown[] = [];
  for (const e of split.events) {
    if (budget <= 0) {
      dropped.push(`event "${e.actionText.slice(0, 40)}" (daily proposal cap reached)`);
      continue;
    }
    budget--;
    events.push(
      await park(ctx, "log_event", { ...e }, {
        title: e.actionText.slice(0, 80),
        preview: `**${e.actionText}**${e.occurredOn ? `\n\nWhen: ${e.occurredOn}` : ""}`,
        warnings: e.occurredOn ? [] : ["No date given."],
      }),
    );
  }

  return {
    status: "split",
    pages: cards,
    facts,
    events,
    // Never silently truncate: if the dump produced more than we proposed, say so.
    dropped,
    note:
      "Nothing has been written. Summarise in a couple of lines what you've broken the dump into — pages, facts, " +
      "events — and say each card is confirmed separately. If anything was dropped, say what and why.",
  };
}

// --- shared plumbing --------------------------------------------------------

/**
 * Body of the two plain-text-confirmation tools. Split by tier so each tool's
 * description can be honest about what it does: a tool called `apply_doc_edit`
 * must not quietly save a fact.
 */
async function applyConfirmed(ctx: ToolContext, pendingId: string, tier: "kb" | "memory"): Promise<ToolReply> {
  try {
    const existing = await getPendingAction(pendingId);
    if (!existing) return failed("That proposal doesn't exist.");
    if (isKbWrite(existing.tool) !== (tier === "kb")) {
      return failed(
        tier === "kb"
          ? "That pendingId is a fact or an event, not a KB change — use confirm_pending."
          : "That pendingId is a KB change — use apply_doc_edit.",
      );
    }
    const result = await confirmPendingAction(pendingId, ctx.user, {
      conversationId: ctx.conversationId,
      onWritten: ctx.onWritten,
    });
    if (!result.ok) return failed(result.error);
    return { status: "applied", summary: result.summary };
  } catch (err) {
    return failed(message(err));
  }
}

/**
 * Confirm and execute a pending action. The ONLY path to a chat-originated
 * write, shared by the confirm route (button) and the apply_pending tool
 * (plain-text "yes").
 *
 * `actor` must come from a session. The claim is a compare-and-set, so a
 * double-click or a simultaneous button-and-tool confirm executes once; if the
 * executor then throws, the row goes back to pending so the user can retry.
 */
export async function confirmPendingAction(
  pendingId: string,
  actor: ActingUser,
  opts: { conversationId?: string | null; onWritten?: ExecuteOptions["onWritten"] } = {},
): Promise<{ ok: true; summary: string; docId?: string } | { ok: false; error: string; status: number }> {
  await expireStalePendingActions();
  const existing = await getPendingAction(pendingId);
  if (!existing) return { ok: false, error: "That proposal doesn't exist.", status: 404 };

  // Ownership: a pending action may only be confirmed by the user it was made
  // to. Nothing the model says can move a payload between people.
  if (existing.userId !== actor.id) {
    return { ok: false, error: "That proposal belongs to someone else.", status: 403 };
  }
  if (opts.conversationId !== undefined && existing.conversationId && existing.conversationId !== opts.conversationId) {
    return { ok: false, error: "That proposal was made in a different conversation.", status: 403 };
  }
  if (existing.status !== "pending") {
    return { ok: false, error: `That proposal was already ${existing.status}.`, status: 409 };
  }

  // Policy is re-checked at confirm time, not just at propose time: the mode
  // may have flipped to shadow, or chat writes may have been switched off,
  // between Mort offering the card and the user clicking it.
  if (isKbWrite(existing.tool)) {
    const route = await resolveKbWriteRoute(actor);
    if (route.route !== "apply") return { ok: false, error: route.reason, status: 403 };
  }

  const claimed = await claimPendingAction(pendingId, "confirmed", actor.label);
  if (!claimed) return { ok: false, error: "That proposal has expired or was already decided.", status: 409 };

  try {
    const result = await executePendingAction(claimed, actor, { onWritten: opts.onWritten });
    return { ok: true, summary: result.summary, docId: result.docId };
  } catch (err) {
    await releasePendingAction(pendingId);
    return { ok: false, error: message(err), status: 500 };
  }
}

export function isKbWrite(tool: PendingTool): boolean {
  return tool === "apply_doc_edit" || tool === "create_doc" || tool === "attach_source";
}

/** Cancel a pending action. Same ownership rule as confirming. */
export async function cancelPendingAction(
  pendingId: string,
  actor: ActingUser,
): Promise<{ ok: boolean; error?: string; status: number }> {
  const existing = await getPendingAction(pendingId);
  if (!existing) return { ok: false, error: "That proposal doesn't exist.", status: 404 };
  if (existing.userId !== actor.id) return { ok: false, error: "That proposal belongs to someone else.", status: 403 };
  const claimed = await claimPendingAction(pendingId, "cancelled", actor.label);
  return claimed ? { ok: true, status: 200 } : { ok: false, error: "Already decided.", status: 409 };
}

/**
 * Divert a pending action into the admin review queue instead of applying it —
 * the "Send to review" button. Used when the person in the chat would rather a
 * second pair of eyes looked at it.
 */
export async function sendPendingToReview(
  pendingId: string,
  actor: ActingUser,
): Promise<{ ok: boolean; error?: string; status: number }> {
  const existing = await getPendingAction(pendingId);
  if (!existing) return { ok: false, error: "That proposal doesn't exist.", status: 404 };
  if (existing.userId !== actor.id) return { ok: false, error: "That proposal belongs to someone else.", status: 403 };
  if (!isKbWrite(existing.tool)) {
    return { ok: false, error: "Only KB changes go to the review queue — facts and events are yours to confirm.", status: 400 };
  }

  const claimed = await claimPendingAction(pendingId, "cancelled", actor.label);
  if (!claimed) return { ok: false, error: "Already decided.", status: 409 };

  const p = claimed.payload as Record<string, string | undefined>;
  const sourceId = chatSourceId(claimed.conversationId);
  const action = claimed.tool === "create_doc" ? "CREATE" : claimed.tool === "attach_source" ? "ATTACH" : "UPDATE_ADDITIVE";
  await enqueueReview({
    action,
    sourceId: claimed.tool === "attach_source" ? (p.sourceId ?? sourceId) : sourceId,
    targetDocId: p.targetDocId ?? null,
    rationale: `${p.rationale ?? "proposed in chat"} (sent to review by ${actor.label})`,
    payload: { title: p.title, collection: p.collection ?? null, regionBody: p.regionBody },
    dedupeKey: `chat:${claimed.id}`,
  });
  return { ok: true, status: 200 };
}

async function queueForReview(
  ctx: ToolContext,
  item: {
    action: string;
    targetDocId: string | null;
    sourceId?: string;
    rationale: string;
    payload?: Record<string, unknown>;
    reason: string;
  },
): Promise<ToolReply> {
  const sourceId = item.sourceId ?? chatSourceId(ctx.conversationId);
  // The dedupe key includes the TITLE, not just the target. A brain dump fans
  // one conversation out into several CREATEs, which all share a source id and
  // have no target — keyed on those alone, only the first page would ever reach
  // the queue and the rest would vanish silently.
  const subject = String((item.payload as { title?: string } | undefined)?.title ?? item.targetDocId ?? "new");
  await enqueueReview({
    action: item.action,
    sourceId,
    targetDocId: item.targetDocId,
    rationale: `${item.rationale} (proposed in chat by ${ctx.user.label})`,
    payload: item.payload,
    // One proposal per (action, conversation, subject) — asking twice in the
    // same conversation updates nothing rather than stacking duplicates.
    dedupeKey: `chat:${item.action}:${sourceId}:${subject}`,
  });
  return {
    status: "queued_for_review",
    reason: item.reason,
    note: "Tell the user it's gone to the admin review queue, in one line, and why. Do not claim the wiki changed.",
  };
}

function previewText(p: DocEditPreview): string {
  const head = p.appendsNewRegion
    ? `**${p.title}** has no Mort section yet — this adds one at the end. Nothing already on the page is touched.`
    : `**${p.title}** — replacing Mort's section (+${p.added} −${p.removed} lines). Human content outside his markers is untouched.`;
  return head;
}

function editWarnings(p: DocEditPreview): string[] {
  const warnings: string[] = [];
  if (p.humanEditedSince) {
    warnings.push("Someone edited this page by hand since Mort last wrote to it — check the diff before applying.");
  }
  if (p.removed > 0 && p.added === 0) {
    warnings.push("This only removes content from Mort's section.");
  }
  return warnings;
}

/** Chat-authored pages carry the same metadata header as ingested ones. */
function buildRegionBody(
  input: { body: string; zone: string[]; system: string[]; entities: string[]; docType: string | null },
  conversationId: string | null,
): string {
  return [
    renderMetadataHeader({
      zone: input.zone,
      system: input.system,
      docType: input.docType,
      entities: input.entities,
      sourceFiles: [chatSourceId(conversationId)],
      sourceTier: "word",
    }),
    input.body.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type { PendingAction };
