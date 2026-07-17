import { classifyRole } from "./classify.js";
import type { DecideInput, DecideResult, Decision } from "./decide.js";
import type { KbHit } from "./kbclient.js";
import { renderMetadataHeader, roleToTier } from "./metadata.js";
import type { FileRole } from "./types.js";

/**
 * One Mort turn (MORT_PLAN §v1.3): classify → search → decide → act (or propose).
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
};

export type TurnDeps = {
  kbSearch: (query: string, limit?: number) => Promise<KbHit[]>;
  /** Other files already in Mort's library that look related (his own corpus, not the KB). */
  listRelatedFiles?: (file: TurnFile) => Promise<Array<{ sourceId: string; role: string; summary: string | null }>>;
  getDocumentText: (docId: string) => Promise<string | null>;
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
  understanding: { summary: string; zone: string[]; system: string[]; entities: string[] };
};

function searchQuery(file: TurnFile): string {
  // Folder + filename are strong placement hints; lead with them.
  return [file.folderPath, file.fileName.replace(/\.[a-z0-9]+$/i, "")].filter(Boolean).join(" ");
}

export async function runMortTurn(file: TurnFile, cfg: TurnConfig, deps: TurnDeps): Promise<TurnOutcome> {
  const role = classifyRole(file);
  const [candidates, relatedFiles] = await Promise.all([
    deps.kbSearch(searchQuery(file), 5),
    deps.listRelatedFiles ? deps.listRelatedFiles(file) : Promise.resolve([]),
  ]);
  const top = candidates[0];
  const candidateBody = top ? await deps.getDocumentText(top.docId) : null;

  const { decision, tokens } = await deps.decide({
    fileName: file.fileName,
    folderPath: file.folderPath,
    role,
    extractedMarkdown: file.extractedMarkdown,
    candidates,
    candidateBody,
    relatedFiles,
  });

  // Recorded in the library on every path — even SKIP/HOLD. This is how Mort
  // stays aware of a file he didn't turn into an article.
  const understanding = {
    summary: decision.summary,
    zone: decision.zone,
    system: decision.system,
    entities: decision.entities,
  };

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
  const candidateIds = new Set(candidates.map((c) => c.docId));
  const inventedTarget = decision.targetDocId != null && !candidateIds.has(decision.targetDocId);

  // Mort's region = a rendered metadata header (model's classification + facts
  // the code already knows) followed by the cleaned body.
  const regionBody = [
    renderMetadataHeader({
      zone: decision.zone,
      system: decision.system,
      docType: decision.docType,
      entities: decision.entities,
      sourceFiles: [file.fileName],
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
