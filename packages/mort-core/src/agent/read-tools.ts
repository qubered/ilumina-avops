import { tool } from "ai";
import { z } from "zod";
import { eventProvenance, factHistory, listCurrentFacts, searchMemory, type MortFact } from "../memory";
import { describeProvenance, eventChipFrom, factChip, type ProvenanceChip } from "../memory/provenance";
import { embedQuery } from "../kb/embeddings";
import { searchEvents } from "../kb/events-store";
import { documentUrl, getDocumentOrNull } from "../kb/outline";
import { extractMortRegion } from "../kb/region";
import { searchKb } from "../kb/store";

/**
 * The `read` tier of the belt (MORT_V2_PLAN I.3) — everything Mort can look at
 * without changing anything.
 *
 * Split out of agent/index.ts in P4 so the registry can import the tools
 * without importing the system prompt and the belt assembly that sit on top of
 * them. Every channel gets these; they are the only tools ingest and the dream
 * have at all.
 */

export type KbSearchResult = {
  /** The Outline document id — the only ids a write tool will act on. */
  docId: string;
  breadcrumb: string;
  title: string;
  url: string;
  score: number;
  text: string;
};

/**
 * kb_search, optionally bound to a turn's set of seen doc ids.
 *
 * That set is the invented-target guard (P3): a write tool will only touch a
 * page Mort actually found. Without it a model will cheerfully emit a
 * plausible-looking id that either 403s against Outline or, far worse, lands on
 * a real but wrong page.
 */
export function buildKbSearchTool(seen?: Set<string>) {
  return tool({
    description:
      "Search the ILUMINA AV Ops knowledge base. Returns the most relevant KB chunks with their document ids, source page titles and URLs. Use focused queries; search multiple times for multi-part questions.",
    inputSchema: z.object({
      query: z.string().describe("A focused search query about AV operations at ILUMINA"),
    }),
    execute: async ({ query }): Promise<KbSearchResult[] | { error: string }> => {
      try {
        const vector = await embedQuery(query);
        const hits = await searchKb(vector, 5);
        for (const h of hits) seen?.add(h.docId);
        return hits.map((h) => ({
          docId: h.docId,
          breadcrumb: h.breadcrumb,
          title: h.title,
          url: h.url,
          score: h.score,
          text: h.text,
        }));
      } catch (err) {
        // Return the failure as a tool result instead of throwing: the model
        // can then tell the user the KB is unreachable rather than the whole
        // stream dying (graceful degradation, brief §12).
        console.error("[kb_search] failed:", err);
        return {
          error:
            "Knowledge base search is unavailable right now (vector store or embedding service unreachable). Tell the user you cannot search the KB at the moment and to try again shortly — do not answer from memory.",
        };
      }
    },
  });
}

export const kbSearchTool = buildKbSearchTool();

/**
 * Read one KB page in full, with the human's half of it separated from Mort's.
 *
 * Necessary before proposing an edit: propose_doc_edit replaces Mort's region
 * wholesale, so without seeing the current region an "edit" silently deletes
 * everything he didn't happen to repeat.
 */
export function buildKbGetDocTool(seen?: Set<string>) {
  return tool({
    description:
      "Read a KB page in full by its document id (from a kb_search result). Returns the page's human-written " +
      "content and, separately, Mort's own maintained section. ALWAYS call this before proposing an edit — the " +
      "edit replaces Mort's section wholesale, so you need its current content to change one part of it.",
    inputSchema: z.object({
      docId: z.string().describe("The Outline document id, exactly as kb_search returned it."),
    }),
    execute: async ({ docId }): Promise<Record<string, unknown>> => {
      try {
        const doc = await getDocumentOrNull(docId);
        if (!doc) return { error: `No KB page with id '${docId}'. Search for it first.` };
        seen?.add(doc.id);
        const region = extractMortRegion(doc.text);
        return {
          docId: doc.id,
          title: doc.title,
          url: documentUrl(doc),
          fullText: doc.text,
          mortRegion: region,
          note:
            region == null
              ? "This page has no Mort section yet — an edit appends one and leaves the existing content untouched."
              : "Only mortRegion is yours to rewrite. Everything else on the page is a human's and is preserved byte-for-byte.",
        };
      } catch (err) {
        console.error("[kb_get_doc] failed:", err);
        return { error: "Could not read that page from Outline right now." };
      }
    },
  });
}

/**
 * A tool result that carries its own attribution (P2). `provenance` is the
 * structured record — the assistant lifts it onto the message so the UI can
 * chip it — and `knownFrom` is the same thing as the sentence Mort should say
 * if asked how he knows.
 */
export type WithProvenance<T> = T & { provenance: ProvenanceChip; knownFrom: string };

function attribute<T>(payload: T, chip: ProvenanceChip): WithProvenance<T> {
  return { ...payload, provenance: chip, knownFrom: describeProvenance(chip) };
}

function factPayload(f: MortFact) {
  return attribute(
    {
      id: f.id,
      key: f.factKey,
      value: f.value,
      scope: f.scope,
      effectiveFrom: f.effectiveFrom,
      effectiveTo: f.effectiveTo,
      approvedBy: f.approvedBy,
      note: f.note,
    },
    factChip(f),
  );
}

export const eventLogTool = tool({
  description:
    "Search the operational event log — dated records of actions the crew actually performed at the venue (e.g. 'ran SDI under floor', 'raised LED wall to 2.5m'). Use for 'what did we do', 'last time', 'when did we', and current physical-state questions. Returns dated observations, NOT documented procedures. Each result carries who reported it and where, in `knownFrom`.",
  inputSchema: z.object({
    query: z.string().describe("A focused query about what was done at the venue"),
  }),
  execute: async ({ query }): Promise<Array<Record<string, unknown>> | { error: string }> => {
    try {
      const vector = await embedQuery(query);
      const hits = await searchEvents(vector, 6);
      // Points indexed before P2 have no provenance in their payload, so read
      // it back from Postgres — the row always has it, the vector may not.
      const provenance = await eventProvenance(
        hits.map((h) => ({ sourceId: h.sourceId, rowHash: h.rowHash })),
      ).catch(() => new Map<string, never>());
      return hits.map((h) => {
        // Fall back to whatever the point carried if the row lookup failed —
        // a degraded attribution beats dropping the answer.
        const known = provenance.get(`${h.sourceId} ${h.rowHash}`) ?? {
          reportedBy: h.reportedBy ?? null,
          conversationId: h.conversationId ?? null,
        };
        return attribute(
          {
            action: h.actionText,
            date: h.occurredOn,
            event: h.event,
            zone: h.zone,
            system: h.system,
            score: h.score,
          },
          eventChipFrom({ actionText: h.actionText, occurredOn: h.occurredOn, sourceId: h.sourceId }, known),
        );
      });
    } catch (err) {
      console.error("[event_log] failed:", err);
      return { error: "The event log is unavailable right now — say so and don't guess dated facts." };
    }
  },
});

export const mortMemoryTool = tool({
  description:
    "Search Mort's OWN memory — his decision journal (what he did to the knowledge base and why, with the actor and channel behind each entry) and the file→document map. Use when asked why a page is filed where it is, what Mort changed recently, who asked for a change, or which source files feed a page. NOT for venue facts (use kb_search), NOT for what the crew did (use event_log), and NOT for where a current-state value came from (use current_state, which carries its own provenance).",
  inputSchema: z.object({
    query: z.string().describe("What to look up in Mort's journal / file map"),
  }),
  execute: async ({ query }): Promise<Record<string, unknown>> => {
    // limit: 12 preserves the old HTTP client's default (mort-review.ts's
    // searchMortMemory) — core's own searchMemory() defaults to 20.
    const res = await searchMemory({ q: query, limit: 12 });
    if (res.journal.length === 0 && res.files.length === 0) {
      return { note: "Nothing in Mort's memory matches that." };
    }
    return res;
  },
});

export const currentStateTool = tool({
  description:
    "Look up human-APPROVED current-state facts — deliberate decisions about what is true NOW at the venue (e.g. 'LED wall height = 2.5m, Main Stage, effective 2026-07-12, approved by Jayden'). Check this for 'what is it now / what's the current X' questions. An approved fact outranks both the KB's documented standard and any event-log observation. Every fact comes back with `knownFrom` — who taught it, when, and through which door — so 'how do you know that?' and 'who told you?' are answered from here. Set `history` when asked what a value USED TO BE or when it changed.",
  inputSchema: z.object({
    query: z.string().describe("What current-state value to look up (e.g. 'LED wall height')"),
    history: z
      .boolean()
      .optional()
      .describe(
        "Also return what each matching fact replaced, newest first. Use for 'what was it before', 'when did that change', 'who changed it'.",
      ),
  }),
  execute: async ({ query, history }): Promise<Record<string, unknown>> => {
    const facts = await listCurrentFacts(query);
    if (facts.length === 0) {
      return {
        note: "No approved current-state fact covers that — fall back to the KB standard and the event log.",
      };
    }
    const current = facts.map(factPayload);
    if (!history) return { facts: current };

    // Each fact's chain, retired rows included: "6m now, was 2.5m before —
    // Jayden changed it on 23 July". Scope is part of the key, so a chain is
    // per (key, scope) and never mixes Main Stage with the PFA.
    const chains = await Promise.all(
      facts.map(async (f) => ({
        key: f.factKey,
        scope: f.scope,
        previously: (await factHistory(f.factKey, { scope: f.scope }))
          .filter((h) => h.id !== f.id)
          .map(factPayload),
      })),
    );
    return { facts: current, history: chains.filter((c) => c.previously.length > 0) };
  },
});

/** The read-only belt — safe on any channel, no acting user required. */
export const agentTools = {
  kb_search: kbSearchTool,
  event_log: eventLogTool,
  mort_memory: mortMemoryTool,
  current_state: currentStateTool,
};
