import {
  gather as coreGather,
  searchQueries as coreSearchQueries,
  type Facets,
  type GatherDeps,
  type Gathered,
} from "@mort/core/agent/gather";
import type { Understanding } from "./understand.js";

/**
 * Pass 2 of a Mort turn — moved into mort-core (v2/P3) so the chat brain-dump
 * flow finds existing pages exactly the way ingestion does. This file is the
 * ingest pipeline's adapter over it: the core subject is a `label` (a filename
 * here, a topic title in chat), and everything else is unchanged.
 *
 * See @mort/core/agent/gather for why the multi-axis search exists.
 */

export { mergeHits } from "@mort/core/agent/gather";
export type { GatherDeps, Gathered };

export type GatherFile = { sourceId: string; fileName: string; folderPath?: string };

const asSubject = (file: GatherFile) => ({
  sourceId: file.sourceId,
  label: file.fileName,
  folderPath: file.folderPath,
});

const asFacets = (u: Understanding): Facets => ({
  summary: u.summary,
  zone: u.zone,
  system: u.system,
  entities: u.entities,
});

export function searchQueries(file: GatherFile, u: Understanding): string[] {
  return coreSearchQueries(asSubject(file), asFacets(u));
}

export function gather(file: GatherFile, u: Understanding, deps: GatherDeps): Promise<Gathered> {
  return coreGather(asSubject(file), asFacets(u), deps);
}
