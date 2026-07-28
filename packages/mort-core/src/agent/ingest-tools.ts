import { tool, type Tool } from "ai";
import { z } from "zod";
import type { FileRole } from "../memory/types";
import { renderMetadataHeader, roleToTier } from "../kb/mort-header";
import { extractMortRegion } from "../kb/region";
import type { WriteDeps } from "../kb/write-deps";
import { resolveKbWriteRoute } from "../tools/policy";
import type { ToolContext } from "../tools/harness";
import { chatGatherDeps } from "./dump";
import { gather, type GatherDeps, type Gathered } from "./gather";

/**
 * The authoring belt (MORT_V2_PLAN I.2, v1's deferred R6): the tools an ingest
 * turn uses to decide what the knowledge base should do about a file.
 *
 * What changed from the v1 pipeline, and what deliberately didn't.
 *
 * Changed: the shape. `understand → gather → decide` was three model calls in a
 * fixed order, each blind to what the next one would want. It is now one
 * bounded agent turn on the same belt and the same harness as chat — Mort says
 * what the file is, is handed the retrieval that follows from that, and can
 * then go and look at what he still doesn't know before committing. The
 * pipeline could not read a second candidate page even when the first one made
 * obvious that it should.
 *
 * Didn't change: every guard. Shadow mode, the confidence gate and the
 * invented-target rule all still apply to every write — they just live in
 * `resolveKbWriteRoute` now, which also covers chat. The metadata header is
 * still rendered by code from the facets Mort supplies, never by the model.
 * Related links are still filtered to files actually offered. ATTACH with
 * nowhere to go is still a hold, not review noise. HOLD and SKIP are still
 * ungated, because there is nothing for a human to approve.
 *
 * These tools are named apart from chat's `create_doc` / `propose_doc_edit` /
 * `attach_source` on purpose. They sit at the same tier and obey the same
 * routing, but they are not the same tools: chat's park a card for a person to
 * confirm, and these execute under the gates because there is no person on the
 * channel. One name, two behaviours would be the worse lie.
 */

export type IngestFile = {
  sourceId: string;
  fileName: string;
  folderPath?: string;
  contentType?: string;
  extractedMarkdown: string;
  extractionKind?: string;
  /** From the deterministic classifier — pre-processing, not a model judgement. */
  role: FileRole;
};

/** What Mort made of the file. The same four facets pass 1 produced in v1. */
export type IngestUnderstanding = {
  summary: string;
  zone: string[];
  system: string[];
  entities: string[];
  docType: string | null;
};

export type IngestAction = "CREATE" | "UPDATE_ADDITIVE" | "ATTACH" | "HOLD" | "REVIEW" | "SKIP";
export type IngestExecuted = "created" | "updated" | "attached" | "review" | "skipped" | "held";

/** The one decision a turn reaches, and what actually became of it. */
export type IngestDecision = {
  action: IngestAction;
  executed: IngestExecuted;
  docId?: string;
  rationale: string;
  confidence: number | null;
};

/** Retrieval is core's own; only the write executors have to be injected. */
export type IngestDeps = WriteDeps & Partial<GatherDeps>;

/**
 * One turn's authoring state, carried on the ToolContext.
 *
 * It exists because two of the guards are stateful: "a file Mort was actually
 * offered" is a property of what happened earlier in THIS turn, and "he has
 * already decided" is what stops a second decision. (The third — "a page Mort
 * actually saw" — is `ctx.seen`, which the shared read tools already maintain.)
 */
export type IngestTurnState = {
  file: IngestFile;
  deps: IngestDeps;
  /** Library sourceIds Mort has genuinely been offered — the Related-link guard. */
  offered: Set<string>;
  understanding: IngestUnderstanding | null;
  /** What note_understanding pulled up, kept for the candidates' titles. */
  gathered: Gathered | null;
  /** Set exactly once, by whichever terminal tool the turn reaches. */
  decision: IngestDecision | null;
};

export function newIngestState(file: IngestFile, deps: IngestDeps): IngestTurnState {
  return { file, deps, offered: new Set(), understanding: null, gathered: null, decision: null };
}

/**
 * A turn is over when a decision was actually RECORDED — not when a decision
 * tool was merely called. The difference matters: a model that reaches for
 * create_page before saying what the file is gets refused, and refusing it has
 * to leave the turn alive so it can do the step it skipped. Stopping on the
 * call itself would turn every such slip into a silent hold.
 */
export const hasDecided = (ctx: ToolContext): boolean => ctx.ingest?.decision != null;

const NOT_UNDERSTOOD =
  "Call note_understanding first. Deciding what the KB should do with a file before saying what the file IS is how " +
  "duplicate pages get made — and it is also how you end up targeting a page you never looked at.";

const ALREADY_DECIDED = "You've already decided about this file. One file, one decision — stop here.";

const NO_TURN = "There is no file in front of you — this tool only means anything on an authoring turn.";

/**
 * Pass 1 and pass 2, fused into one tool.
 *
 * They are fused on purpose. The R7 multi-axis retrieval — search by placement,
 * by what the thing is, by the gear it names, by system and zone, then read the
 * strongest few pages in full — is the single most valuable thing the v1
 * pipeline did, and it is entirely determined by the facets Mort has just
 * produced. Making him ask for it separately would mean sometimes he doesn't,
 * and a turn that skipped retrieval is exactly the turn that creates a
 * duplicate page. So stating what the file is *is* the request for the corpus
 * around it. He can still search further with kb_search; he just cannot start
 * from nothing.
 */
export function noteUnderstandingTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "FIRST STEP, always. Say what this file IS — not what should happen to it. In return you get everything in " +
      "the knowledge base that bears on it: the candidate pages, the current content of the closest ones, and the " +
      "other files Mort already holds about the same gear. Your zone/system/entities are what that search runs on, " +
      "so name the specific gear and rooms the CONTENT mentions (filenames routinely lie). Leave a field empty " +
      "rather than guessing at it — a vague term finds the wrong pages, which is worse than finding none.",
    inputSchema: z.object({
      summary: z
        .string()
        .describe(
          "One line: what this file is (e.g. 'grandMA3 show file for Main Stage, v4'). This goes in Mort's " +
            "library, so it must still make sense to someone who never sees the file.",
        ),
      zone: z.array(z.string()).describe("Venue zones this concerns (e.g. Main Stage). Empty if not applicable."),
      system: z.array(z.string()).describe("Systems this concerns (Video, Audio, Lighting, Network…). Empty if none."),
      entities: z.array(z.string()).describe("Specific gear/rooms named in the content (grandMA3, LED wall). Empty if none."),
      docType: z.string().nullable().describe("Document type (How-to, Reference, Policy, Troubleshooting…) or null."),
    }),
    execute: async (u): Promise<Record<string, unknown>> => {
      const state = ctx.ingest;
      if (!state) return { error: NO_TURN };
      if (state.decision) return { error: ALREADY_DECIDED };
      state.understanding = u;

      const gathered = await gather(
        { sourceId: state.file.sourceId, label: state.file.fileName, folderPath: state.file.folderPath },
        { summary: u.summary, zone: u.zone, system: u.system, entities: u.entities },
        gatherDepsFor(state),
      );
      state.gathered = gathered;
      // Everything Mort has now genuinely seen: candidates may be targeted,
      // library files may be linked. Both guards read these two sets.
      for (const c of gathered.candidates) ctx.seen.add(c.docId);
      for (const f of gathered.library) state.offered.add(f.sourceId);

      return {
        noted: true,
        candidates: gathered.candidates.map((c) => ({
          docId: c.docId,
          title: c.title,
          breadcrumb: c.breadcrumb,
          score: Number(c.score.toFixed(3)),
        })),
        // The mort region only. The rest of a page belongs to a human, and Mort
        // can neither rewrite it nor should he be tempted to restate it.
        currentContent: gathered.bodies.map((b) => ({
          docId: b.docId,
          title: b.title,
          mortRegion: extractMortRegion(b.text) ?? "(no Mort section yet)",
        })),
        library: gathered.library,
        note:
          gathered.candidates.length === 0
            ? "The KB has nothing like this. That makes create_page or hold_file the honest options — do not invent a page id."
            : "targetDocId must be copied verbatim from this candidate list. Read a page with kb_get_doc before you edit it.",
      };
    },
  });
}

// --- the terminal tools -----------------------------------------------------

const RELATED_HELP =
  "sourceIds of library files you actually drew on, or that a reader of this page would want — copied verbatim " +
  "from what you were shown. These become Related links. Empty if none applied; do not list a file just because " +
  "it was offered.";

const CONFIDENCE_HELP =
  "Your honest 0-1 confidence. A low one sends this to a human for review, which is the right outcome — don't " +
  "inflate it to get your way.";

export function createPageTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "File this as a NEW knowledge-base page. Only when nothing you were shown is genuinely about this subject — " +
      "sharing vocabulary is not being about it. Two pages about the same rack is how a wiki becomes useless: the " +
      "crew find one, act on it, and it's the stale one. Ends the turn.",
    inputSchema: z.object({
      title: z.string().min(1).describe("The page title in the KB's style — specific, not a sentence, not the filename."),
      collection: z.string().nullable().describe("The Outline collection it belongs in, or null for the default."),
      bodyMarkdown: z
        .string()
        .min(1)
        .describe(
          "The cleaned article body in markdown. No metadata header and no H1 title — Mort renders those himself. " +
            "Never state a fact the file doesn't contain.",
        ),
      relatedSourceIds: z.array(z.string()).describe(RELATED_HELP),
      rationale: z.string().describe("One or two sentences: why a new page rather than extending one of the candidates."),
      confidence: z.number().min(0).max(1).describe(CONFIDENCE_HELP),
    }),
    execute: async (input): Promise<Record<string, unknown>> => {
      const state = ctx.ingest;
      const bad = precheck(state);
      if (bad || !state) return bad ?? { error: NO_TURN };

      const regionBody = renderRegion(state, input.bodyMarkdown, input.relatedSourceIds);
      const route = await resolveKbWriteRoute({ channel: "ingest" }, { confidence: input.confidence });
      if (route.route !== "apply") {
        return propose(state, {
          action: "CREATE",
          targetDocId: null,
          rationale: input.rationale,
          confidence: input.confidence,
          payload: { title: input.title, collection: input.collection, regionBody },
          reason: route.reason,
        });
      }

      const docId = await state.deps.createDoc({
        title: input.title,
        collection: input.collection,
        regionBody,
        sourceId: state.file.sourceId,
      });
      state.decision = {
        action: "CREATE",
        executed: "created",
        docId,
        rationale: input.rationale,
        confidence: input.confidence,
      };
      return { status: "created", docId, note: "Done. The turn ends here." };
    },
  });
}

export function updatePageTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "Extend an existing KB page with what this file adds — the preferred outcome whenever a page is genuinely " +
      "about this subject. Read it with kb_get_doc first: this REPLACES Mort's section of that page, so the text " +
      "you give must include everything already in it that should stay. Ends the turn.",
    inputSchema: z.object({
      targetDocId: z.string().describe("Copied verbatim from the candidate list or a search result. Never invented."),
      bodyMarkdown: z
        .string()
        .min(1)
        .describe(
          "The FULL content of Mort's section after this change, in markdown — the current section with the new " +
            "material merged in. No metadata header, no H1 title. Keep what is already there unless this file " +
            "actually corrects it.",
        ),
      relatedSourceIds: z.array(z.string()).describe(RELATED_HELP),
      rationale: z.string().describe("One or two sentences: what this file adds to that page."),
      confidence: z.number().min(0).max(1).describe(CONFIDENCE_HELP),
    }),
    execute: async (input): Promise<Record<string, unknown>> => {
      const state = ctx.ingest;
      const bad = precheck(state);
      if (bad || !state) return bad ?? { error: NO_TURN };

      const inventedTarget = !ctx.seen.has(input.targetDocId);
      const regionBody = renderRegion(state, input.bodyMarkdown, input.relatedSourceIds);
      const route = await resolveKbWriteRoute({ channel: "ingest" }, { confidence: input.confidence, inventedTarget });
      if (route.route !== "apply") {
        return propose(state, {
          action: "UPDATE_ADDITIVE",
          // Never hand a human an id to act on that Mort made up.
          targetDocId: inventedTarget ? null : input.targetDocId,
          rationale: inventedTarget
            ? `${input.rationale} [target '${input.targetDocId}' is not one of the KB candidates — Mort guessed it, so this needs a human]`
            : input.rationale,
          confidence: input.confidence,
          // The title is what the review queue shows a human. It's the PAGE's
          // title, from what Mort was shown — not the model's, which for an
          // edit it was never asked for.
          payload: { title: titleOf(state, input.targetDocId), regionBody },
          reason: route.reason,
        });
      }

      await state.deps.updateRegion(input.targetDocId, regionBody);
      state.decision = {
        action: "UPDATE_ADDITIVE",
        executed: "updated",
        docId: input.targetDocId,
        rationale: input.rationale,
        confidence: input.confidence,
      };
      return { status: "updated", docId: input.targetDocId, note: "Done. The turn ends here." };
    },
  });
}

export function attachToPageTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "Attach this file to a page as an artifact — the right call for anything you'd link or download rather than " +
      "read: show files, config exports, schematics, photos, drawings. Reference material NEVER becomes its own " +
      "page. If no page for it exists yet, use hold_file instead and it gets attached when one appears. Ends the turn.",
    inputSchema: z.object({
      targetDocId: z.string().describe("The page to attach it to, copied verbatim from what you were shown."),
      rationale: z.string().describe("One line: why that file belongs on that page."),
      confidence: z.number().min(0).max(1).describe(CONFIDENCE_HELP),
    }),
    execute: async (input): Promise<Record<string, unknown>> => {
      const state = ctx.ingest;
      const bad = precheck(state);
      if (bad || !state) return bad ?? { error: NO_TURN };

      // An attach with nowhere real to go is not a proposal a human can action
      // — there is no page to attach to. Don't make it review noise: hold the
      // file, and re-check it when a page it belongs on appears.
      if (!ctx.seen.has(input.targetDocId)) {
        state.decision = {
          action: "HOLD",
          executed: "held",
          rationale: `${input.rationale} [wanted to attach to '${input.targetDocId}', which isn't a page Mort found]`,
          confidence: input.confidence,
        };
        return {
          status: "held",
          note:
            "That page id isn't one you were shown, so there is nothing to attach to. The file is held in the " +
            "library and re-checked when a page it belongs on appears. The turn ends here.",
        };
      }

      const route = await resolveKbWriteRoute({ channel: "ingest" }, { confidence: input.confidence });
      if (route.route !== "apply" || !state.deps.attachFile) {
        return propose(state, {
          action: "ATTACH",
          targetDocId: input.targetDocId,
          rationale: input.rationale,
          confidence: input.confidence,
          reason: route.route === "apply" ? "No attach executor is wired, so this goes to review." : route.reason,
        });
      }

      await state.deps.attachFile(input.targetDocId, state.file.sourceId);
      state.decision = {
        action: "ATTACH",
        executed: "attached",
        docId: input.targetDocId,
        rationale: input.rationale,
        confidence: input.confidence,
      };
      return { status: "attached", docId: input.targetDocId, note: "Done. The turn ends here." };
    },
  });
}

export function holdFileTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "Keep the file, do nothing to the KB. The right answer more often than it looks: an artifact whose page " +
      "doesn't exist yet, reference material with no home, or anything you simply aren't sure deserves a page. " +
      "Holding is cheap and reversible — Mort re-checks held files whenever a new page appears. A junk page is " +
      "neither. Ends the turn.",
    inputSchema: z.object({ rationale: z.string().describe("One line: why this is held rather than filed.") }),
    execute: async ({ rationale }): Promise<Record<string, unknown>> => {
      const state = ctx.ingest;
      const bad = precheck(state);
      if (bad || !state) return bad ?? { error: NO_TURN };
      state.decision = { action: "HOLD", executed: "held", rationale, confidence: null };
      return { status: "held", note: "Filed in the library, nothing written. The turn ends here." };
    },
  });
}

export function skipFileTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "This file is genuinely nothing — empty, a duplicate of something already filed, or irrelevant to venue AV " +
      "operations. Not the same as hold_file: skip means there is nothing here worth keeping in view. Ends the turn.",
    inputSchema: z.object({ rationale: z.string().describe("One line: why there's nothing here.") }),
    execute: async ({ rationale }): Promise<Record<string, unknown>> => {
      const state = ctx.ingest;
      const bad = precheck(state);
      if (bad || !state) return bad ?? { error: NO_TURN };
      state.decision = { action: "SKIP", executed: "skipped", rationale, confidence: null };
      return { status: "skipped", note: "Nothing done. The turn ends here." };
    },
  });
}

export function sendToReviewTool(ctx: ToolContext): Tool {
  return tool({
    description:
      "Hand this to a human. Use it when the right move is a merge, a restructure or an overwrite, or when two " +
      "candidate pages are both plausible and picking wrong would matter. Not a way to avoid deciding — an unsure " +
      "create or edit already goes to review on its own confidence. Ends the turn.",
    inputSchema: z.object({
      rationale: z.string().describe("What you'd do and what you want a human to settle."),
      targetDocId: z.string().nullable().describe("The page it concerns, if it concerns one. Copied verbatim, or null."),
      title: z.string().nullable().describe("A title, if you're proposing a page."),
      collection: z.string().nullable(),
      bodyMarkdown: z.string().nullable().describe("The body you'd write, if you have one. No header, no H1."),
    }),
    execute: async (input): Promise<Record<string, unknown>> => {
      const state = ctx.ingest;
      const bad = precheck(state);
      if (bad || !state) return bad ?? { error: NO_TURN };
      const invented = input.targetDocId != null && !ctx.seen.has(input.targetDocId);
      return propose(state, {
        action: "REVIEW",
        targetDocId: invented ? null : input.targetDocId,
        rationale: input.rationale,
        confidence: null,
        payload: input.bodyMarkdown
          ? { title: input.title, collection: input.collection, regionBody: renderRegion(state, input.bodyMarkdown, []) }
          : undefined,
        reason: "Sent to the review queue.",
      });
    },
  });
}

// --- shared plumbing --------------------------------------------------------

/** Retrieval is core's own unless a caller (a test, the parity harness) says otherwise. */
function gatherDepsFor(state: IngestTurnState): GatherDeps {
  const fallback = chatGatherDeps();
  return {
    kbSearch: state.deps.kbSearch ?? fallback.kbSearch,
    getDocumentText: state.deps.getDocumentText ?? fallback.getDocumentText,
    listRelatedFiles: state.deps.listRelatedFiles ?? fallback.listRelatedFiles,
  };
}

/** A candidate page's title, for the review queue's benefit. */
function titleOf(state: IngestTurnState, docId: string): string | null {
  return state.gathered?.candidates.find((c) => c.docId === docId)?.title ?? null;
}

/** The two things true of every terminal tool: understood first, decided once. */
function precheck(state: IngestTurnState | undefined): { error: string } | null {
  if (!state) return { error: NO_TURN };
  if (!state.understanding) return { error: NOT_UNDERSTOOD };
  if (state.decision) return { error: ALREADY_DECIDED };
  return null;
}

/**
 * Mort's region = a metadata header rendered by CODE from the facets he stated,
 * followed by the body he wrote. The header is not the model's to write: its
 * deterministic half (source file, folder, tier, maintained-by, date) is what
 * the whole KB is indexed and traced by, and a model that improvises it breaks
 * the parser quietly.
 *
 * Related links are filtered to files Mort was actually offered — the same rule
 * as the invented-target guard, for the same reason: a Related link to a file
 * that does not exist reads as authoritative and is worse than no link.
 */
function renderRegion(state: IngestTurnState, bodyMarkdown: string, relatedSourceIds: string[]): string {
  const u = state.understanding!;
  const related = relatedSourceIds.filter((id) => state.offered.has(id));
  return [
    renderMetadataHeader({
      zone: u.zone,
      system: u.system,
      docType: u.docType,
      entities: u.entities,
      sourceFiles: [state.file.fileName],
      related,
      folderOrigin: state.file.folderPath ?? null,
      sourceTier: roleToTier(state.file.role),
    }),
    bodyMarkdown.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function propose(
  state: IngestTurnState,
  item: {
    action: IngestAction;
    targetDocId: string | null;
    rationale: string;
    confidence: number | null;
    payload?: Record<string, unknown>;
    reason: string;
  },
): Promise<Record<string, unknown>> {
  await state.deps.enqueueReview({
    action: item.action,
    sourceId: state.file.sourceId,
    targetDocId: item.targetDocId,
    rationale: item.rationale,
    payload: item.payload,
    dedupeKey: `${item.action}:${state.file.sourceId}:${item.targetDocId ?? "new"}`,
  });
  state.decision = {
    action: item.action,
    executed: "review",
    docId: item.targetDocId ?? undefined,
    rationale: item.rationale,
    confidence: item.confidence,
  };
  return { status: "queued_for_review", reason: item.reason, note: "Nothing was written. The turn ends here." };
}
