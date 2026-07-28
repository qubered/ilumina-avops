/** Shared memory types now live in mort-core; re-exported here so existing imports keep working. */
export type {
  FileRole,
  RelationKind,
  SourceStatus,
  ReviewStatus,
  MortSource,
  MortDoc,
  MortDocState,
  ReviewItem,
  LibraryEntry,
  DocEntry,
} from "@mort/core/memory/types";

// `DecisionAction` is ingest-pipeline-specific (not shared memory), so it
// stays here — derived from the Zod-inferred `Decision` type instead of
// hand-duplicated, so it can't drift out of sync again (it used to be
// missing "HOLD").
import type { Decision } from "./decide.js";
export type DecisionAction = Decision["action"];
