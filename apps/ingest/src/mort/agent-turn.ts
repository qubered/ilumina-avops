import { runIngestTurn } from "@mort/core/agent/run-turn";
import type { IngestExecuted } from "@mort/core/agent/ingest-tools";
import type { TurnDeps, TurnFile, TurnOutcome } from "./turn.js";
import type { FileRole } from "./types.js";

/**
 * The ingest service's adapter over `runIngestTurn` (v2/P6).
 *
 * It exists so the worker doesn't have to care which engine ran: same input,
 * same `TurnOutcome`, same journal semantics — one row per decision carrying
 * the action, the rationale, the confidence and what the turn cost. That
 * sameness is not cosmetic. It's what makes the two engines diffable (see
 * `scripts/parity.ts`) and what keeps the journal continuous across the
 * cutover, so "what did Mort do to this file, and why" reads the same either
 * side of it.
 *
 * classify() stays where it was — deterministic pre-processing, run by the
 * worker before either engine sees the file.
 */

/** Journal action names, identical to the v1 pipeline's. (A proposal is named
 *  after what it proposes — `proposed:CREATE` — so it isn't in this map.) */
const JOURNAL_ACTION: Record<Exclude<IngestExecuted, "review">, string> = {
  created: "create",
  updated: "update",
  attached: "attach",
  skipped: "skip",
  held: "hold",
};

export async function runMortAgentTurn(file: TurnFile, role: FileRole, deps: TurnDeps): Promise<TurnOutcome> {
  const { decision, understanding, tokens } = await runIngestTurn(
    {
      sourceId: file.sourceId,
      fileName: file.fileName,
      folderPath: file.folderPath,
      contentType: file.contentType,
      extractedMarkdown: file.extractedMarkdown,
      extractionKind: file.extractionKind,
      role,
    },
    deps,
  );

  await deps.journal({
    sourceId: file.sourceId,
    outlineDocumentId: decision.executed === "review" ? null : (decision.docId ?? null),
    action: decision.executed === "review" ? `proposed:${decision.action}` : JOURNAL_ACTION[decision.executed],
    rationale: decision.rationale,
    confidence: decision.confidence ?? undefined,
    tokens,
  });

  return {
    role,
    decided: decision.action,
    executed: decision.executed,
    docId: decision.docId,
    // A turn that ran out of steps before saying what the file was still has to
    // record something in the library, or the file drops out of Mort's view
    // entirely and never gets re-checked.
    understanding: understanding ?? {
      summary: `${file.fileName} — not yet described (the turn ended before Mort said what it was)`,
      zone: [],
      system: [],
      entities: [],
      docType: null,
    },
  };
}
