import type { KbHit } from "./kbclient.js";
import type { RelatedFile } from "./decide.js";
import type { Understanding } from "./understand.js";

/**
 * Pass 2 of a Mort turn (MORT_PLAN §R7): with the file understood, pull up
 * everything that might bear on it before deciding anything.
 *
 * What this replaces: one kb_search on "folder + filename", one candidate body,
 * and a library lookup filtered to the same folder. That found the obvious page
 * and nothing else. A file is often useful in several places, and the page it
 * belongs on is frequently not the one its filename resembles.
 *
 * Now: several searches along different axes, merged; the top few pages read in
 * full, not just the single best; and the library queried by what the file is
 * ABOUT rather than where it happens to sit.
 */

export type Gathered = {
  /** Merged, deduped, best-first. The ONLY docs the decision may target. */
  candidates: KbHit[];
  /** Full text of the strongest candidates, best first. */
  bodies: Array<{ docId: string; title: string; text: string }>;
  /** Files already in Mort's library that bear on this one. */
  library: RelatedFile[];
};

export type GatherDeps = {
  kbSearch: (query: string, limit?: number) => Promise<KbHit[]>;
  getDocumentText: (docId: string) => Promise<string | null>;
  listRelatedFiles?: (params: {
    excludeSourceId: string;
    folderOrigin?: string | null;
    system?: string[];
    entities?: string[];
  }) => Promise<RelatedFile[]>;
};

export type GatherFile = { sourceId: string; fileName: string; folderPath?: string };

/** Candidates carried into the decision. Above ~6 the prompt gets noisy and the
 *  model starts pattern-matching on titles instead of reading. */
const MAX_CANDIDATES = 6;
/** Candidate bodies read in full. Each is up to 8k chars in the prompt, so this
 *  is the main cost lever in the turn. Three is enough to tell near-duplicates
 *  apart, which is the judgement that actually needs the text. */
const MAX_BODIES = 3;

/**
 * The axes Mort searches along. One query cannot serve all of these: filename
 * and folder are about where a file CAME FROM, while the summary and entities
 * are about what it's FOR, and those routinely disagree.
 */
export function searchQueries(file: GatherFile, u: Understanding): string[] {
  const base = file.fileName.replace(/\.[a-z0-9]+$/i, "");
  const queries = [
    // Placement: what the folder and name suggest. Often right, cheaply.
    [file.folderPath, base].filter(Boolean).join(" "),
    // Semantics: what the thing actually is, in Mort's own words.
    u.summary,
    // Specificity: named gear finds the page about that gear, wherever it lives.
    u.entities.join(" "),
    // Facet: the broad system/zone sweep, for when nothing else lands.
    [...u.system, ...u.zone].join(" "),
  ];
  // Dedup and drop the empties — a file with no entities shouldn't fire a blank
  // search, which returns arbitrary top hits and puts unrelated docs in front of
  // the model as if they were candidates. Only blank: short is not the same as
  // meaningless, and in this venue half the gear is called things like "E2".
  return [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
}

/**
 * Merge hits from several searches. A doc found by more than one axis is more
 * likely to be the right one, so it keeps its best score and gets nudged up —
 * but only slightly: agreement is evidence, not proof, and a runaway bonus
 * would let four weak matches outrank one strong one.
 */
export function mergeHits(results: KbHit[][], limit = MAX_CANDIDATES): KbHit[] {
  const best = new Map<string, { hit: KbHit; hits: number }>();
  for (const list of results) {
    for (const hit of list) {
      const prev = best.get(hit.docId);
      if (!prev) {
        best.set(hit.docId, { hit, hits: 1 });
      } else {
        prev.hits++;
        if (hit.score > prev.hit.score) prev.hit = hit;
      }
    }
  }
  return [...best.values()]
    .map(({ hit, hits }) => ({ hit, rank: hit.score * (1 + 0.05 * (hits - 1)) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map(({ hit }) => hit);
}

export async function gather(file: GatherFile, u: Understanding, deps: GatherDeps): Promise<Gathered> {
  const queries = searchQueries(file, u);

  const [results, library] = await Promise.all([
    Promise.all(
      // A single failing search must not lose the others — degraded retrieval
      // beats no turn at all.
      queries.map((q) =>
        deps.kbSearch(q, MAX_CANDIDATES).catch((err) => {
          console.warn(`[mort] kb_search failed for "${q.slice(0, 60)}": ${err instanceof Error ? err.message : err}`);
          return [] as KbHit[];
        }),
      ),
    ),
    deps.listRelatedFiles
      ? deps
          .listRelatedFiles({
            excludeSourceId: file.sourceId,
            folderOrigin: file.folderPath ?? null,
            system: u.system,
            entities: u.entities,
          })
          .catch(() => [] as RelatedFile[])
      : Promise.resolve([] as RelatedFile[]),
  ]);

  const candidates = mergeHits(results);

  // Read the strongest few in full. Titles and snippets are enough to shortlist
  // but not to tell "update this page" from "this is a different page that
  // happens to share vocabulary" — that call needs the actual text.
  const bodies: Gathered["bodies"] = [];
  for (const c of candidates.slice(0, MAX_BODIES)) {
    const text = await deps.getDocumentText(c.docId);
    if (text) bodies.push({ docId: c.docId, title: c.title, text });
  }

  return { candidates, bodies, library };
}
