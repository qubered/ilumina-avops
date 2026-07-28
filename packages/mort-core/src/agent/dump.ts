import { generateObject } from "ai";
import { z } from "zod";
import { MORT_AUTHORING_PREAMBLE } from "../identity";
import { embedQuery } from "../kb/embeddings";
import { getDocumentOrNull } from "../kb/outline";
import { extractMortRegion } from "../kb/region";
import { searchKb } from "../kb/store";
import { listRelatedSources } from "../memory";
import { getChatModel } from "../model/chat";
import { gather, type Facets, type GatherDeps, type Gathered, type KbHit } from "./gather";

/**
 * The brain dump (MORT_V2_PLAN Part II): paste a wall of unstructured
 * information — "here's everything about the new comms setup" — and Mort turns
 * it into properly formatted KB pages, facts and event-log entries, one
 * confirmation card at a time.
 *
 * It runs the same shape the ingest pipeline runs, because the judgement is the
 * same judgement: understand what you're looking at, GATHER what already exists,
 * and only then decide. The v1 rule survives verbatim — prefer extending an
 * existing page over creating a near-duplicate — and it survives because the
 * gather step is literally the same function ingestion calls.
 *
 * A dump is not a page. One paragraph about the comms rack and one sentence
 * about the LED wall height are two different KB objects, and the second one is
 * a fact, not prose. Splitting first is what stops both from being buried in a
 * single sprawling article.
 */

const pageSchema = z.object({
  title: z.string().describe("Page title in the KB's style — specific, not a sentence."),
  summary: z.string().describe("One line: what this topic IS. Used to find the existing page, so be concrete."),
  body: z
    .string()
    .describe(
      "This topic's content as a properly formatted KB page body in markdown: a short intro, then ## headings, " +
        "numbered steps where the source gives steps, tables for specs. Rewrite the dump's prose into documentation " +
        "— do not paste it. Never invent detail the dump doesn't contain. No metadata header (added for you).",
    ),
  collection: z.string().nullable().describe("Outline collection it belongs in, or null for the default."),
  zone: z.array(z.string()).describe("Venue zones named in this part. Empty if none."),
  system: z.array(z.string()).describe("Systems named in this part (Video, Audio, Lighting, Network…)."),
  entities: z.array(z.string()).describe("Specific gear/rooms named in this part."),
  docType: z.string().nullable().describe("How-to, Reference, Policy, Troubleshooting… or null."),
});

const factSchema = z.object({
  factKey: z.string().describe("Short stable key, e.g. 'LED wall height'."),
  value: z.string().describe("The value now in force, e.g. '6m'."),
  scope: z.string().nullable().describe("Where it applies, e.g. 'Main Stage'. Null if venue-wide."),
  effectiveFrom: z.string().nullable().describe("ISO date yyyy-mm-dd it took effect, or null."),
  note: z.string().nullable(),
});

const eventSchema = z.object({
  actionText: z.string().describe("What was DONE, one line, in the crew's own words."),
  occurredOn: z.string().nullable().describe("ISO date yyyy-mm-dd it happened, or null."),
  event: z.string().nullable().describe("The show/job it was part of, if named."),
  zone: z.array(z.string()),
  system: z.array(z.string()),
  entities: z.array(z.string()),
});

export const dumpSplitSchema = z.object({
  pages: z.array(pageSchema).describe("One entry per DISTINCT topic that deserves its own KB page. Often 1."),
  facts: z
    .array(factSchema)
    .describe(
      "Statements about what is true NOW — a setting, a height, a current configuration. These belong in " +
        "current-state memory, not buried in a page's prose. Empty if the dump has none.",
    ),
  events: z
    .array(eventSchema)
    .describe(
      "Statements about what the crew DID, on a date. These belong in the event log. Empty if the dump has none.",
    ),
});

export type DumpPage = z.infer<typeof pageSchema>;
export type DumpFact = z.infer<typeof factSchema>;
export type DumpEvent = z.infer<typeof eventSchema>;
export type DumpSplit = z.infer<typeof dumpSplitSchema>;

const SPLIT_INSTRUCTIONS = `Split this dump into the KB objects it actually contains. You are not writing to
anything yet — another pass decides whether each page is new or an edit to an existing one.

Three kinds of thing come out of a dump, and putting one in the wrong bucket is the main way this goes wrong:

- PAGES — documentation: how something works, how to do it, what the setup is. One page per distinct
  topic. Do NOT split a single topic across pages because it is long, and do NOT merge two unrelated
  topics because they arrived in the same paragraph.
- FACTS — "what is true NOW": a current setting, height, address, configuration. Short, keyed, dated.
  A fact does not belong in a page's prose, because a page is a documented standard and a fact is a
  live value that changes.
- EVENTS — "what we DID", on a date. Past tense, dated, observational.

Rules:
- Never invent content. Everything you write must be traceable to the dump. Where the dump is vague,
  keep it vague — a page that reads as authoritative but is half-guessed is worse than a short one.
- Prefer fewer, better pages. Two pages that would each be three lines are one page.
- If the dump is about ONE thing, return ONE page. This is the common case.`;

/** How much of a dump the split pass reads. Beyond this the model stops splitting and starts summarising. */
const MAX_DUMP = 24_000;

export async function splitDump(text: string): Promise<{ split: DumpSplit; tokens: number }> {
  const { object, usage } = await generateObject({
    model: await getChatModel(),
    schema: dumpSplitSchema,
    maxRetries: 2,
    system: `${MORT_AUTHORING_PREAMBLE}\n\n${SPLIT_INSTRUCTIONS}`,
    prompt: text.slice(0, MAX_DUMP),
  });
  return { split: object, tokens: usage?.totalTokens ?? 0 };
}

// --- placing each page ------------------------------------------------------

const placementSchema = z.object({
  action: z
    .enum(["CREATE", "UPDATE_ADDITIVE"])
    .describe("UPDATE_ADDITIVE when one of the candidate pages is ABOUT this topic; CREATE only when none is."),
  targetDocId: z
    .string()
    .nullable()
    .describe("For UPDATE_ADDITIVE: the docId of the candidate to extend, copied exactly. Null for CREATE."),
  title: z.string().describe("Title for a new page, or the existing page's title for an update."),
  collection: z.string().nullable(),
  regionBody: z
    .string()
    .describe(
      "The FULL content of Mort's region after this change, in markdown, with no metadata header (added for you). " +
        "For UPDATE_ADDITIVE this is the candidate's CURRENT region with the new material merged in — keep what is " +
        "already there unless the dump explicitly corrects it. For CREATE it is the new page body.",
    ),
  rationale: z.string().describe("One line: why this page, and why extend rather than create (or vice versa)."),
  confidence: z.number().min(0).max(1).describe("How sure you are this lands in the right place."),
});

export type Placement = z.infer<typeof placementSchema> & { page: DumpPage; candidates: KbHit[] };

const PLACE_INSTRUCTIONS = `Decide where this material goes in the knowledge base.

The rule that matters: EXTEND an existing page rather than create a near-duplicate. Two pages about the
same rack is the failure mode that makes a wiki useless — the crew find one, act on it, and it's the stale
one. Create a new page only when none of the candidates is genuinely about this topic; sharing vocabulary
is not being about it.

For UPDATE_ADDITIVE you are given the candidate's current Mort region. Return that region with the new
material merged in, keeping what is already there unless the dump explicitly corrects it. Anything outside
Mort's markers is a human's writing and you never see or touch it.

Copy docIds exactly from the candidate list. Never write a docId that is not on it — if nothing fits,
that is a CREATE, and saying so is the right answer.`;

/** The gather deps for a chat-side turn: core's own search and Outline reader. */
export function chatGatherDeps(): GatherDeps {
  return {
    kbSearch: async (query, limit = 6) => {
      const vector = await embedQuery(query);
      const hits = await searchKb(vector, limit);
      return hits.map((h) => ({
        docId: h.docId,
        title: h.title,
        url: h.url,
        breadcrumb: h.breadcrumb,
        score: h.score,
        text: h.text,
        zone: h.zone,
        system: h.system,
        docType: h.docType,
      }));
    },
    getDocumentText: async (docId) => {
      const doc = await getDocumentOrNull(docId);
      return doc?.text ?? null;
    },
    listRelatedFiles: (params) => listRelatedSources({ ...params, limit: 8 }),
  };
}

const facetsOf = (page: DumpPage): Facets => ({
  summary: page.summary,
  zone: page.zone,
  system: page.system,
  entities: page.entities,
});

/**
 * Find where one dumped topic belongs and write the resulting region body.
 * Returns the placement plus the candidates it was allowed to target — the
 * caller uses that set to enforce the invented-target guard, exactly as the
 * ingest turn does.
 */
export async function placeDumpPage(
  page: DumpPage,
  sourceId: string,
): Promise<{ placement: Placement; gathered: Gathered; tokens: number }> {
  const gathered = await gather({ sourceId, label: page.title }, facetsOf(page), chatGatherDeps());

  const candidateBlock = gathered.candidates.length
    ? gathered.candidates
        .map((c, i) => `${i + 1}. docId: ${c.docId}\n   title: ${c.title}\n   breadcrumb: ${c.breadcrumb}`)
        .join("\n")
    : "(none — the KB has nothing like this)";

  // Show the current mort region of each read candidate, not the whole page:
  // the region is the only part an update may rewrite, and showing the human
  // half invites the model to "helpfully" restate it inside the region.
  const bodyBlock = gathered.bodies.length
    ? gathered.bodies
        .map((b) => `--- ${b.title} (docId ${b.docId}) — Mort's current region ---\n${extractMortRegion(b.text) ?? "(no Mort region yet)"}`)
        .join("\n\n")
    : "(no candidate bodies)";

  const { object, usage } = await generateObject({
    model: await getChatModel(),
    schema: placementSchema,
    maxRetries: 2,
    system: `${MORT_AUTHORING_PREAMBLE}\n\n${PLACE_INSTRUCTIONS}`,
    prompt: [
      `Topic: ${page.title}`,
      `What it is: ${page.summary}`,
      page.collection ? `Suggested collection: ${page.collection}` : "",
      "",
      "New material to file:",
      page.body,
      "",
      "Candidate pages already in the KB:",
      candidateBlock,
      "",
      bodyBlock,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  return {
    placement: { ...object, page, candidates: gathered.candidates },
    gathered,
    tokens: usage?.totalTokens ?? 0,
  };
}
