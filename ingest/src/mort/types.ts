/** Shared types for Mort's memory + decision model (v1). */

/** What kind of thing a source file is — decides how Mort handles it. */
export type FileRole = "truth" | "structured" | "reference" | "media" | "event_log" | "unknown";

/** The single structured decision Mort emits per file (v1 — not a multi-step loop). */
export type DecisionAction = "CREATE" | "UPDATE_ADDITIVE" | "ATTACH" | "REVIEW" | "SKIP";

/** How a source relates to a doc it touched. */
export type RelationKind = "authored" | "attached" | "updated";

export type SourceStatus = "active" | "tombstoned";
export type ReviewStatus = "pending" | "approved" | "rejected";

/** A source file Mort knows about (corpus map). `sourceId` is the watcher's rel path. */
export interface MortSource {
  sourceId: string;
  checksum: string | null;
  role: FileRole;
  folderOrigin: string | null;
  status: SourceStatus;
  summary: string | null;
}

/** A KB document Mort maintains. `mortId` is Mort's own canonical slug. */
export interface MortDoc {
  mortId: string;
  outlineDocumentId: string;
  collection: string | null;
  title: string;
  folderOrigin: string | null;
  system: string | null;
  /** UNIQUE dedup key: derived from (folderOrigin, system, normalised title). */
  registryKey: string;
}

/** Per-doc write state — powers curated-doc detection + revision CAS. */
export interface MortDocState {
  outlineDocumentId: string;
  lastMortRevisionId: string | null;
  lastMortBodyHash: string | null;
}

/** A proposal a human must approve before it executes. */
export interface ReviewItem {
  action: string; // 'tombstone' | 'structural' | 'overwrite' | 'merge' | 'low_confidence' | …
  sourceId?: string | null;
  mortId?: string | null;
  targetDocId?: string | null;
  payload?: unknown;
  rationale?: string | null;
  /** UNIQUE — makes re-proposals idempotent. */
  dedupeKey: string;
}
