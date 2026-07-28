import { tool } from "ai";
import { z } from "zod";
import { chatSourceId, previewDocEdit, type DocEditPreview } from "../kb/chat-write";
import { restampHeader } from "../kb/mort-header";
import { documentUrl, getDocumentOrNull } from "../kb/outline";
import { enqueueReview } from "../memory";
import { isKbWriteTool, type PendingTool } from "../memory/pending";
import { resolveKbWriteRoute } from "../tools/policy";
import { raiseCard, remainingCardBudget, type ChatToolContext, type PendingCard, type ToolFailure } from "./cards";
import { placeDumpPage, splitDump } from "./dump";

/**
 * The `write:kb` belt (MORT_V2_PLAN I.3, Part II) — fixing the wiki from chat.
 *
 * Same two rules as the teaching tools, for the same reason:
 *
 *  1. **No tool writes.** Each one raises a card and returns a preview; the
 *     write happens once a session-authenticated human confirms, with
 *     attribution stamped from their session.
 *  2. **Policy is resolved here, not in the prompt.** `resolveKbWriteRoute`
 *     weighs role, runtime mode, confidence and whether the target is a page
 *     Mort actually found, and answers apply / review / blocked. A member's
 *     correction becomes a review-queue proposal however the conversation went.
 *
 * The third rule is inherited rather than restated: every write goes through
 * the v1 safe-write machinery, so Mort can only ever rewrite his own fenced
 * region and a page with a malformed region is never auto-spliced.
 */

type KbReply =
  | PendingCard
  | ToolFailure
  | { status: "queued_for_review"; reason: string; note: string }
  | { status: "blocked"; reason: string };

const REGION_BODY_HELP =
  "The FULL new content of Mort's section of that page, in markdown. This REPLACES the section wholesale, so " +
  "include everything that should remain: read the page with kb_get_doc first and edit its current mortRegion " +
  "rather than writing a fragment. Content outside Mort's markers belongs to a human and is never touched.";

const REVIEW_NOTE =
  "Tell the user in one line that it's gone to the admin review queue, and why. Do NOT claim the wiki changed.";

export function buildKbTools(ctx: ChatToolContext) {
  return {
    propose_doc_edit: tool({
      description:
        "Correct or extend an existing KB page. Use this when the user says a page is wrong or out of date " +
        '("that patching page is wrong, it\'s actually X"). Shows them a before/after diff of Mort\'s section; ' +
        "nothing is written until they confirm. Read the page with kb_get_doc first.",
      inputSchema: z.object({
        targetDocId: z
          .string()
          .describe("The Outline document id — MUST come from a kb_search or kb_get_doc result, never invented."),
        regionBody: z.string().describe(REGION_BODY_HELP),
        rationale: z.string().describe("One line: what is changing, and why the user's correction is right."),
        confidence: z.number().min(0).max(1).describe("How sure you are this edit is correct and well-targeted."),
      }),
      execute: (input) => proposeDocEdit(ctx, input),
    }),

    create_doc: tool({
      description:
        "Create a NEW KB page. Only once kb_search has shown there is no existing page to extend — updating an " +
        "existing page always beats a near-duplicate. Nothing is written until the user confirms.",
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe("The page title, in the KB's style — specific, not a sentence."),
        collection: z.string().nullable().describe("Outline collection it belongs in, or null for the default."),
        body: z
          .string()
          .min(1)
          .describe(
            "The page body in markdown, following KB conventions: a short intro, then ## headings, numbered steps " +
              "where the source gives steps, tables for specs. Do NOT write the metadata header — it is added for you.",
          ),
        zone: z.array(z.string()).describe("Venue zones this concerns (e.g. Main Stage). Empty if none."),
        system: z.array(z.string()).describe("Systems this concerns (Video, Audio, Lighting, Network…)."),
        entities: z.array(z.string()).describe("Specific gear/rooms named in the content."),
        docType: z.string().nullable().describe("How-to, Reference, Policy, Troubleshooting… or null."),
        rationale: z.string().describe("One line: why this deserves its own page rather than an edit."),
        confidence: z.number().min(0).max(1),
      }),
      execute: async (input): Promise<KbReply> => {
        try {
          const regionBody = buildRegionBody(input.body, input, ctx.conversationId);
          return await createDoc(ctx, {
            title: input.title,
            collection: input.collection,
            regionBody,
            rationale: input.rationale,
            confidence: input.confidence,
          });
        } catch (err) {
          return { error: message(err) };
        }
      },
    }),

    attach_source: tool({
      description:
        "Attach a file Mort already holds in his library (see mort_memory) to a KB page, listed under the page's " +
        "Files section. Nothing is written until the user confirms.",
      inputSchema: z.object({
        targetDocId: z.string().describe("The Outline document id — from a kb_search or kb_get_doc result."),
        sourceId: z.string().describe("The library source id of the file, exactly as mort_memory gave it."),
        rationale: z.string().describe("One line: why that file belongs on that page."),
      }),
      execute: async ({ targetDocId, sourceId, rationale }): Promise<KbReply> => {
        try {
          const inventedTarget = !ctx.seen.has(targetDocId);
          const doc = await getDocumentOrNull(targetDocId);
          if (!doc) return { error: `No Outline document with id '${targetDocId}'.` };

          const route = await resolveKbWriteRoute(ctx.user, { inventedTarget });
          if (route.route === "blocked") return { status: "blocked", reason: route.reason };
          if (route.route === "review") {
            return queueForReview(ctx, {
              action: "ATTACH",
              targetDocId: inventedTarget ? null : targetDocId,
              sourceId,
              subject: sourceId,
              rationale,
              reason: route.reason,
            });
          }

          return await raiseCard(
            ctx,
            "attach_source",
            { targetDocId, sourceId, title: doc.title, rationale },
            `Attach ${sourceId} to “${doc.title}” — ${rationale}`,
            { docUrl: documentUrl(doc), warnings: [] },
          );
        } catch (err) {
          return { error: message(err) };
        }
      },
    }),

    brain_dump: tool({
      description:
        "Turn a wall of unstructured information the user has just pasted or dictated (\"here's everything about " +
        'the new comms setup") into properly formatted KB pages, facts and event-log entries. Use this instead of ' +
        "answering when a message is long and informational rather than a question. Mort finds the existing pages " +
        "first and prefers extending them to making duplicates. Writes nothing — it returns one card per resulting " +
        "page, fact and event, each confirmed separately.",
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .describe("The user's dump, verbatim. Do not summarise or reformat it — the splitter needs the original."),
      }),
      execute: async ({ text }): Promise<Record<string, unknown>> => {
        try {
          return await runBrainDump(ctx, text);
        } catch (err) {
          console.error("[brain_dump] failed:", err);
          return {
            error:
              "Couldn't break that down just now — say so and offer to take it one topic at a time instead. Nothing was written.",
          };
        }
      },
    }),
  };
}

// --- propose_doc_edit, shared with the brain dump ---------------------------

/**
 * Propose an edit to an existing page. The brain dump's UPDATE_ADDITIVE branch
 * calls this rather than reimplementing it, so both paths get the same policy
 * check, the same malformed-region check and the same diff.
 */
async function proposeDocEdit(
  ctx: ChatToolContext,
  input: { targetDocId: string; regionBody: string; rationale: string; confidence: number },
): Promise<KbReply> {
  const { targetDocId, regionBody, rationale, confidence } = input;
  try {
    const inventedTarget = !ctx.seen.has(targetDocId);
    const preview = await previewDocEdit(targetDocId, regionBody);
    if (!preview) return { error: `No Outline document with id '${targetDocId}'. Search for the page first.` };

    // Checked before the policy routing, because it isn't a policy question: a
    // stray marker means we cannot tell where Mort's content ends, so nothing
    // may auto-splice this page, whoever is asking.
    if (preview.malformed) {
      return queueForReview(ctx, {
        action: "UPDATE_ADDITIVE",
        targetDocId,
        subject: preview.title,
        rationale: `${rationale} [page has a malformed Mort region (stray marker) — a human has to untangle it before any automated write]`,
        payload: { title: preview.title, regionBody },
        reason: `“${preview.title}” has a broken Mort marker, so I won't splice it automatically — sent to review.`,
      });
    }

    if (!preview.changed) {
      return { error: `“${preview.title}” already says exactly that — nothing to change.` };
    }

    const route = await resolveKbWriteRoute(ctx.user, { confidence, inventedTarget });
    if (route.route === "blocked") return { status: "blocked", reason: route.reason };

    if (route.route === "review") {
      return queueForReview(ctx, {
        action: "UPDATE_ADDITIVE",
        // Never hand a human a made-up id to act on.
        targetDocId: inventedTarget ? null : targetDocId,
        subject: preview.title,
        rationale: inventedTarget
          ? `${rationale} [target '${targetDocId}' was not among the KB search results — Mort guessed it]`
          : rationale,
        payload: { title: preview.title, regionBody },
        reason: route.reason,
      });
    }

    return await raiseCard(
      ctx,
      "apply_doc_edit",
      { targetDocId, regionBody, rationale, title: preview.title },
      previewLine(preview),
      { diff: preview.diff, docUrl: preview.url, warnings: editWarnings(preview) },
    );
  } catch (err) {
    return { error: message(err) };
  }
}

async function createDoc(
  ctx: ChatToolContext,
  input: {
    title: string;
    collection: string | null;
    regionBody: string;
    rationale: string;
    confidence: number;
  },
): Promise<KbReply> {
  const route = await resolveKbWriteRoute(ctx.user, { confidence: input.confidence });
  if (route.route === "blocked") return { status: "blocked", reason: route.reason };
  if (route.route === "review") {
    return queueForReview(ctx, {
      action: "CREATE",
      targetDocId: null,
      subject: input.title,
      rationale: input.rationale,
      payload: { title: input.title, collection: input.collection, regionBody: input.regionBody },
      reason: route.reason,
    });
  }
  return raiseCard(
    ctx,
    "create_doc",
    {
      title: input.title,
      collection: input.collection,
      regionBody: input.regionBody,
      rationale: input.rationale,
    },
    `New page “${input.title}”${input.collection ? ` in ${input.collection}` : ""}\n\n${input.regionBody}`,
    { warnings: [] },
  );
}

// --- brain dump -------------------------------------------------------------

/**
 * Pages a single dump may fan out into. A dump covering more than this is a
 * document, not a message — and eight cards is already more than anyone will
 * read carefully, which is the number that actually matters.
 */
const MAX_DUMP_PAGES = 8;

async function runBrainDump(ctx: ChatToolContext, text: string): Promise<Record<string, unknown>> {
  let budget = await remainingCardBudget(ctx.user.id);
  if (budget <= 0) {
    return { error: "This user has hit today's confirmation limit — tell them to clear the outstanding ones first." };
  }

  const { split } = await splitDump(text);
  const sourceId = chatSourceId(ctx.conversationId);
  const dropped: string[] = [];

  const pages = split.pages.slice(0, MAX_DUMP_PAGES);
  if (split.pages.length > pages.length) {
    dropped.push(`${split.pages.length - pages.length} further page(s) — that dump covers more than one message should`);
  }

  const cards: unknown[] = [];
  for (const page of pages) {
    if (budget <= 0) {
      dropped.push(`${page.title} (daily confirmation limit reached)`);
      continue;
    }
    budget--;

    const { placement } = await placeDumpPage(page, sourceId);

    // The same guard the ingest turn applies: the model may only target a page
    // it was actually shown. A plausible-looking invented id would land the
    // crew's comms notes on some unrelated page.
    const candidateIds = new Set(placement.candidates.map((c) => c.docId));
    const isUpdate =
      placement.action === "UPDATE_ADDITIVE" &&
      placement.targetDocId != null &&
      candidateIds.has(placement.targetDocId);

    const regionBody = buildRegionBody(placement.regionBody, page, ctx.conversationId);

    if (isUpdate) {
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
      cards.push(
        await createDoc(ctx, {
          title: placement.title,
          collection: placement.collection,
          regionBody,
          rationale: placement.rationale,
          confidence: placement.confidence,
        }),
      );
    }
  }

  // Fact- and event-shaped statements are offered as facts and events rather
  // than buried in a page's prose — one dump fans out into pages AND memory.
  const facts: unknown[] = [];
  for (const f of split.facts) {
    if (budget <= 0) {
      dropped.push(`fact "${f.factKey}" (daily confirmation limit reached)`);
      continue;
    }
    budget--;
    facts.push(await raiseCard(ctx, "save_fact", f, factPreview(f)));
  }

  const events: unknown[] = [];
  for (const e of split.events) {
    if (budget <= 0) {
      dropped.push(`event "${e.actionText.slice(0, 40)}" (daily confirmation limit reached)`);
      continue;
    }
    budget--;
    events.push(await raiseCard(ctx, "log_event", e, eventPreview(e)));
  }

  return {
    status: "split",
    pages: cards,
    facts,
    events,
    // Never truncate silently: a dump that quietly lost half its content reads
    // as "all filed" to the person who pasted it.
    dropped,
    note:
      "NOTHING HAS BEEN WRITTEN. Summarise in a couple of lines what you've broken the dump into — pages, facts, " +
      "events — noting which are edits to existing pages, and say each card is confirmed separately. If anything " +
      "was dropped, say what and why.",
  };
}

// --- shared plumbing --------------------------------------------------------

async function queueForReview(
  ctx: ChatToolContext,
  item: {
    action: string;
    targetDocId: string | null;
    /** What the proposal is ABOUT — part of the dedupe key. */
    subject: string;
    sourceId?: string;
    rationale: string;
    payload?: Record<string, unknown>;
    reason: string;
  },
): Promise<KbReply> {
  const sourceId = item.sourceId ?? chatSourceId(ctx.conversationId);
  await enqueueReview({
    action: item.action,
    sourceId,
    targetDocId: item.targetDocId,
    rationale: `${item.rationale} (proposed in chat by ${ctx.user.email ?? ctx.user.id})`,
    payload: item.payload,
    // Keyed on the SUBJECT, not just the target: a brain dump fans one
    // conversation out into several CREATEs that share a source id and have no
    // target, and keyed on those alone only the first would ever reach the
    // queue — the rest would vanish into ON CONFLICT DO NOTHING.
    dedupeKey: `chat:${item.action}:${sourceId}:${item.subject}`,
  });
  return { status: "queued_for_review", reason: item.reason, note: REVIEW_NOTE };
}

/**
 * Divert a raised card into the admin review queue instead of applying it —
 * the card's "Send to review" button, for when the person in the chat would
 * rather a second pair of eyes looked at it (or when the mode changed under
 * them and applying is no longer on the table).
 *
 * The caller has already claimed the card, so this only enqueues.
 */
export async function divertPendingToReview(
  action: { id: string; tool: PendingTool; conversationId: string | null; payload: Record<string, unknown> },
  actorLabel: string,
): Promise<void> {
  if (!isKbWriteTool(action.tool)) {
    throw new Error("only KB changes go to the review queue — facts and events are the user's own to confirm");
  }
  const p = action.payload as {
    targetDocId?: string;
    sourceId?: string;
    title?: string;
    collection?: string | null;
    regionBody?: string;
    rationale?: string;
  };
  const reviewAction =
    action.tool === "create_doc" ? "CREATE" : action.tool === "attach_source" ? "ATTACH" : "UPDATE_ADDITIVE";

  await enqueueReview({
    action: reviewAction,
    sourceId: action.tool === "attach_source" ? (p.sourceId ?? chatSourceId(action.conversationId)) : chatSourceId(action.conversationId),
    targetDocId: p.targetDocId ?? null,
    rationale: `${p.rationale ?? "proposed in chat"} (sent to review by ${actorLabel})`,
    payload: { title: p.title, collection: p.collection ?? null, regionBody: p.regionBody },
    // Keyed on the card, which is already unique — a card can only be diverted
    // once, so there is nothing to dedupe against here.
    dedupeKey: `chat-card:${action.id}`,
  });
}

function previewLine(p: DocEditPreview): string {
  return p.appendsNewRegion
    ? `“${p.title}” has no Mort section yet — this adds one at the end. Nothing already on the page is touched.`
    : `Update “${p.title}” — replacing Mort's section (+${p.added} −${p.removed} lines). Human content outside his markers is untouched.`;
}

function editWarnings(p: DocEditPreview): string[] {
  const warnings: string[] = [];
  if (p.humanEditedSince) {
    warnings.push("Someone edited this page by hand since Mort last wrote to it — read the diff before applying.");
  }
  if (p.removed > 0 && p.added === 0) {
    warnings.push("This only removes content from Mort's section.");
  }
  return warnings;
}

/**
 * Chat-authored pages carry the same metadata header as ingested ones — the
 * deterministic fields written by code, the semantic ones by the model. Without
 * this the two halves of the KB stop being one KB.
 */
function buildRegionBody(
  body: string,
  facets: { zone: string[]; system: string[]; entities: string[]; docType: string | null },
  conversationId: string | null,
): string {
  return restampHeader(body, {
    zone: facets.zone,
    system: facets.system,
    docType: facets.docType,
    entities: facets.entities,
    sourceFiles: [chatSourceId(conversationId)],
    sourceTier: "word",
  });
}

const factPreview = (f: { factKey: string; value: string; scope?: string | null; effectiveFrom?: string | null }) =>
  `Remember: ${f.factKey}${f.scope ? ` (${f.scope})` : ""} = ${f.value}${f.effectiveFrom ? `, effective ${f.effectiveFrom}` : ""}`;

const eventPreview = (e: { actionText: string; occurredOn?: string | null; event?: string | null }) =>
  `Log to the event log${e.event ? ` [${e.event}]` : ""}: ${e.actionText}${e.occurredOn ? ` on ${e.occurredOn}` : ""}`;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
