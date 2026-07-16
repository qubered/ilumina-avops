import { classifyRole } from "./classify.js";
import type { Decision, DecideInput } from "./decide.js";
import type { KbHit } from "./kbclient.js";
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
  getDocumentText: (docId: string) => Promise<string | null>;
  decide: (input: DecideInput) => Promise<Decision>;
  /** Update Mort's region in an existing doc. */
  updateRegion: (docId: string, regionBody: string) => Promise<void>;
  /** Create a new doc with Mort's region as its body. */
  createDoc: (args: { title: string; collection: string | null; regionBody: string; sourceId: string }) => Promise<string>;
  /** Upload a previously-stored file to a doc and record it in Mort's Files
   *  section (attach executor). Optional — when absent, ATTACH is proposed. */
  attachFile?: (docId: string, sourceId: string) => Promise<void>;
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
  }) => Promise<void>;
};

export type TurnConfig = { mode: TurnMode; confidenceThreshold: number };

export type TurnOutcome = {
  role: FileRole;
  decided: Decision["action"];
  /** What actually happened (may differ from decided when gated to review). */
  executed: "created" | "updated" | "attached" | "review" | "skipped";
  docId?: string;
};

function searchQuery(file: TurnFile): string {
  // Folder + filename are strong placement hints; lead with them.
  return [file.folderPath, file.fileName.replace(/\.[a-z0-9]+$/i, "")].filter(Boolean).join(" ");
}

export async function runMortTurn(file: TurnFile, cfg: TurnConfig, deps: TurnDeps): Promise<TurnOutcome> {
  const role = classifyRole(file);
  const candidates = await deps.kbSearch(searchQuery(file), 5);
  const top = candidates[0];
  const candidateBody = top ? await deps.getDocumentText(top.docId) : null;

  const decision = await deps.decide({
    fileName: file.fileName,
    folderPath: file.folderPath,
    role,
    extractedMarkdown: file.extractedMarkdown,
    candidates,
    candidateBody,
  });

  const base = { sourceId: file.sourceId, action: decision.action, rationale: decision.rationale, confidence: decision.confidence };

  if (decision.action === "SKIP") {
    await deps.journal({ ...base, action: "skip" });
    return { role, decided: "SKIP", executed: "skipped" };
  }

  // Gate: shadow mode, low confidence, or an explicit REVIEW → propose, don't execute.
  const gated = cfg.mode === "shadow" || decision.confidence < cfg.confidenceThreshold || decision.action === "REVIEW";
  if (gated) {
    await deps.enqueueReview({
      action: decision.action,
      sourceId: file.sourceId,
      targetDocId: decision.targetDocId,
      rationale: decision.rationale,
      payload: { title: decision.title, collection: decision.collection, regionBody: decision.regionBody },
      dedupeKey: `${decision.action}:${file.sourceId}:${decision.targetDocId ?? "new"}`,
    });
    await deps.journal({ ...base, action: `proposed:${decision.action}` });
    return { role, decided: decision.action, executed: "review" };
  }

  // Live + confident: execute the safe actions.
  switch (decision.action) {
    case "CREATE": {
      const docId = await deps.createDoc({
        title: decision.title ?? file.fileName,
        collection: decision.collection,
        regionBody: decision.regionBody,
        sourceId: file.sourceId,
      });
      await deps.journal({ ...base, mortId: docId, action: "create" });
      return { role, decided: "CREATE", executed: "created", docId };
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
        return { role, decided: "UPDATE_ADDITIVE", executed: "review" };
      }
      await deps.updateRegion(decision.targetDocId, decision.regionBody);
      await deps.journal({ ...base, mortId: decision.targetDocId, action: "update" });
      return { role, decided: "UPDATE_ADDITIVE", executed: "updated", docId: decision.targetDocId };
    }
    case "ATTACH": {
      // Live + confident + we can attach → do it. Otherwise propose (the worker
      // has stored the bytes so approval can attach later).
      if (decision.targetDocId && deps.attachFile) {
        await deps.attachFile(decision.targetDocId, file.sourceId);
        await deps.journal({ ...base, mortId: decision.targetDocId, action: "attach" });
        return { role, decided: "ATTACH", executed: "attached", docId: decision.targetDocId };
      }
      await deps.enqueueReview({
        action: "ATTACH",
        sourceId: file.sourceId,
        targetDocId: decision.targetDocId,
        rationale: decision.rationale,
        dedupeKey: `ATTACH:${file.sourceId}:${decision.targetDocId ?? "new"}`,
      });
      await deps.journal({ ...base, action: "proposed:ATTACH" });
      return { role, decided: "ATTACH", executed: "review", docId: decision.targetDocId ?? undefined };
    }
    default:
      return { role, decided: decision.action, executed: "review" };
  }
}
