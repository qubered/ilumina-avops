import { classifyRole } from "./classify.js";
import type { DecideInput, DecideResult, Decision, RelatedFile } from "./decide.js";
import { gather, type GatherDeps } from "./gather.js";
import type { KbHit } from "./kbclient.js";
import { renderMetadataHeader, roleToTier } from "./metadata.js";
import type { UnderstandInput, UnderstandResult, Understanding } from "./understand.js";
import type { FileRole } from "./types.js";

/**
 * One Mort turn (MORT_PLAN §v1.3, two-pass since §R7):
 *
 *   classify → understand → gather → decide → act (or propose)
 *
 * The understand/gather split is the difference between a decision made on a
 * filename and one made with the corpus in view. See understand.ts and
 * gather.ts for why each exists.
 *
 * Dependencies are injected so the routing — shadow mode, the confidence gate,
 * CREATE/UPDATE/ATTACH/REVIEW/SKIP dispatch — is unit-testable with fakes, and
 * the production wiring supplies the real LLM / Outline / Postgres deps.
 */

export type TurnMode = "shadow" | "live";

export type TurnFile = {
  sourceId: string;
  fileName: string;
  folderPath?: string;
  contentType?: string;
  extractedMarkdown: string;
  /** What the extractor made of it (docx/pdf/text/spreadsheet/image/…) — part of
   *  judging the role, since a filename alone routinely lies. */
  extractionKind?: string;
};

export type TurnDeps = GatherDeps & {
  kbSearch: (query: string, limit?: number) => Promise<KbHit[]>;
  /** Files already in Mort's library that bear on this one (his own corpus, not the KB). */
  listRelatedFiles?: (params: {
    excludeSourceId: string;
    folderOrigin?: string | null;
    system?: string[];
    entities?: string[];
  }) => Promise<RelatedFile[]>;
  getDocumentText: (docId: string) => Promise<string | null>;
  /** Pass 1: what is this file? */
  understand: (input: UnderstandInput) => Promise<UnderstandResult>;
  /** Pass 3: what should the KB do about it? */
  decide: (input: DecideInput) => Promise<DecideResult>;
  /** Update Mort's region in an existing doc. */
  updateRegion: (docId: string, regionBody: string) => Promise<void>;
  /** Create a new doc with Mort's region as its body. */
  createDoc: (args: { title: string; collection: string | null; regionBody: string; sourceId: string }) => Promise<string>;
  /** Upload a previously-stored file to a doc and record it in Mort's Files
   *  section (attach executor). Optional — when absent, ATTACH is proposed. */
  attachFile?: (docId: string, sourceId: string) => Promise<void>;
  /** Approved-tombstone removal: archive docs a vanished source solely authored. */
  removeSource?: (sourceId: string) => Promise<{ archivedDocIds: string[] }>;
  /** Queue a proposal for human review (idempotent). */
  enqueueReview: (item: {
    action: string;
    sourceId: string;
    targetDocId?: string | null;
    rationale?: string;
    payload?: unknown;
    dedupeKey: string;
  }) => Promise<boolean>;
  journal: (entry: {
    sourceId: string;
    mortId?: string | null;
    action: string;
    rationale?: string;
    confidence?: number;
    tokens?: number;
  }) => Promise<void>;
};

export type TurnConfig = { mode: TurnMode; confidenceThreshold: number };

export type TurnOutcome = {
  role: FileRole;
  decided: Decision["action"];
  /** What actually happened (may differ from decided when gated to review). */
  executed: "created" | "updated" | "attached" | "review" | "skipped" | "held";
  docId?: string;
  /** What Mort understood the file to be — recorded in the library whatever he decided. */
  understanding: Understanding;
};

export async function runMortTurn(file: TurnFile, cfg: TurnConfig, deps: TurnDeps): Promise<TurnOutcome> {
  const role = classifyRole({
    ...file,
    extraction: { kind: file.extractionKind ?? "", text: file.extractedMarkdown },
  });

  // Pass 1 — what is this? Everything downstream keys off the answer.
  const { understanding, tokens: understandTokens } = await deps.understand({
    fileName: file.fileName,
    folderPath: file.folderPath,
    role,
    extractedMarkdown: file.extractedMarkdown,
  });

  // Pass 2 — pull up every page and file that bears on it.
  const gathered = await gather(
    { sourceId: file.sourceId, fileName: file.fileName, folderPath: file.folderPath },
    understanding,
    deps,
  );

  // Pass 3 — decide, with all of that in view.
  const { decision, tokens: decideTokens } = await deps.decide({
    fileName: file.fileName,
    folderPath: file.folderPath,
    role,
    extractedMarkdown: file.extractedMarkdown,
    understanding,
    gathered,
  });

  const tokens = understandTokens + decideTokens;

  const base = {
    sourceId: file.sourceId,
    action: decision.action,
    rationale: decision.rationale,
    confidence: decision.confidence,
    tokens,
  };

  // The model may only target a doc we actually showed it. When kb_search returns
  // nothing (KB empty, or the internal boundary is misconfigured) a model will
  // still happily emit a plausible-looking id — which either 403s against Outline
  // or, far worse, lands on a real but wrong doc. Treat an invented target as an
  // unusable decision and send it to a human.
  const candidateIds = new Set(gathered.candidates.map((c) => c.docId));
  const inventedTarget = decision.targetDocId != null && !candidateIds.has(decision.targetDocId);

  // Same rule for the files it claims to have drawn on: only ones we offered.
  // An invented sourceId would render as a Related link to a file that does not
  // exist, which reads as authoritative and is worse than no link.
  const offeredSourceIds = new Set(gathered.library.map((f) => f.sourceId));
  const related = decision.relatedSourceIds.filter((id) => offeredSourceIds.has(id));

  // Mort's region = a rendered metadata header (the understanding + facts the
  // code already knows) followed by the cleaned body.
  const regionBody = [
    renderMetadataHeader({
      zone: understanding.zone,
      system: understanding.system,
      docType: understanding.docType,
      entities: understanding.entities,
      sourceFiles: [file.fileName],
      related,
      folderOrigin: file.folderPath ?? null,
      sourceTier: roleToTier(role),
    }),
    decision.bodyMarkdown.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");

  if (decision.action === "SKIP") {
    await deps.journal({ ...base, action: "skip" });
    return { role, decided: "SKIP", executed: "skipped", understanding };
  }

  // HOLD: understood and filed in the library, with no KB action — reference
  // material with no home yet, or something not worth a page. It isn't gated to
  // review even in shadow, because there is nothing for a human to approve; the
  // file simply sits in the library (bytes kept) until a page wants it.
  if (decision.action === "HOLD") {
    await deps.journal({ ...base, action: "hold" });
    return { role, decided: "HOLD", executed: "held", understanding };
  }

  // An ATTACH with nowhere to go is not a decision a human can action — there is
  // no page to attach to yet. Don't make it review noise: remember the file and
  // move on. When a page it belongs on appears, the held file is re-checked and
  // attached then.
  if (decision.action === "ATTACH" && (!decision.targetDocId || inventedTarget)) {
    await deps.journal({ ...base, action: "hold:no-target" });
    return { role, decided: "HOLD", executed: "held", understanding };
  }

  // Gate: shadow mode, low confidence, an explicit REVIEW, or a target the model
  // invented → propose, don't execute.
  const gated =
    cfg.mode === "shadow" ||
    decision.confidence < cfg.confidenceThreshold ||
    decision.action === "REVIEW" ||
    inventedTarget;
  if (gated) {
    await deps.enqueueReview({
      action: decision.action,
      sourceId: file.sourceId,
      // Don't pass on a made-up id — a human would try to act on it.
      targetDocId: inventedTarget ? null : decision.targetDocId,
      rationale: inventedTarget
        ? `${decision.rationale} [target '${decision.targetDocId}' is not one of the KB candidates — Mort guessed it, so this needs a human]`
        : decision.rationale,
      payload: { title: decision.title, collection: decision.collection, regionBody },
      dedupeKey: `${decision.action}:${file.sourceId}:${(inventedTarget ? null : decision.targetDocId) ?? "new"}`,
    });
    await deps.journal({ ...base, action: `proposed:${decision.action}` });
    return { role, decided: decision.action, executed: "review", understanding };
  }

  // Live + confident: execute the safe actions.
  switch (decision.action) {
    case "CREATE": {
      const docId = await deps.createDoc({
        title: decision.title ?? file.fileName,
        collection: decision.collection,
        regionBody,
        sourceId: file.sourceId,
      });
      await deps.journal({ ...base, mortId: docId, action: "create" });
      return { role, decided: "CREATE", executed: "created", docId, understanding };
    }
    case "UPDATE_ADDITIVE": {
      if (!decision.targetDocId) {
        // A confident update with no target is incoherent → review instead of guessing.
        await deps.enqueueReview({
          action: "UPDATE_ADDITIVE",
          sourceId: file.sourceId,
          rationale: "update decided but no target doc",
          dedupeKey: `UPDATE_ADDITIVE:${file.sourceId}:notarget`,
        });
        return { role, decided: "UPDATE_ADDITIVE", executed: "review", understanding };
      }
      await deps.updateRegion(decision.targetDocId, regionBody);
      await deps.journal({ ...base, mortId: decision.targetDocId, action: "update" });
      return { role, decided: "UPDATE_ADDITIVE", executed: "updated", docId: decision.targetDocId, understanding };
    }
    case "ATTACH": {
      // Live + confident + we can attach → do it. Otherwise propose (the worker
      // has stored the bytes so approval can attach later).
      if (decision.targetDocId && deps.attachFile) {
        await deps.attachFile(decision.targetDocId, file.sourceId);
        await deps.journal({ ...base, mortId: decision.targetDocId, action: "attach" });
        return { role, decided: "ATTACH", executed: "attached", docId: decision.targetDocId, understanding };
      }
      await deps.enqueueReview({
        action: "ATTACH",
        sourceId: file.sourceId,
        targetDocId: decision.targetDocId,
        rationale: decision.rationale,
        dedupeKey: `ATTACH:${file.sourceId}:${decision.targetDocId ?? "new"}`,
      });
      await deps.journal({ ...base, action: "proposed:ATTACH" });
      return { role, decided: "ATTACH", executed: "review", docId: decision.targetDocId ?? undefined, understanding };
    }
    default:
      return { role, decided: decision.action, executed: "review", understanding };
  }
}
