/**
 * The dream proposal shape moved into mort-core (v2/P6) so the dream can run as
 * a `runTurn` channel — the model call that used to live in dream.ts is gone,
 * replaced by the agent loop's own tools. This file stays as the ingest
 * service's import point; its tests are unchanged.
 */
export {
  DREAM_KINDS,
  dreamDedupeKey,
  dreamSchema,
  knownRefs,
  proposalProblem,
  type DreamInput,
  type DreamProposal,
} from "@mort/core/agent/proposal";
