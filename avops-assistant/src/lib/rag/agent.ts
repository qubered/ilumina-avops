import { tool } from "ai";
import { z } from "zod";
import { embedQuery } from "./embeddings";
import { searchKb } from "./store";

export { getChatModel, systemPromptOptions } from "./model";

/**
 * Agent definition kept importable/server-side so a later Slack bot phase can
 * reuse it (brief §2 non-goals).
 */

// System prompt from the build brief §7 — verbatim.
export const SYSTEM_PROMPT = `You are the ILUMINA AV Operations assistant for venue crew (ILUMINA, Sydney —
AV by Harry The Hirer Productions). Answer operational AV questions using ONLY
the knowledge base via the kb_search tool.
Rules:
- Search the KB before answering. Use multiple searches for multi-part questions.
- Answer with clear, numbered steps where the source gives steps.
- Cite every answer: end with a Sources list of the page titles and URLs you used.
- If the KB does not cover the question, say so plainly and name the closest
  related pages. NEVER invent patch numbers, IP addresses, VLANs, or settings.
- For safety-critical steps (mains power, rigging, work at height), quote the
  source verbatim and tell the user to verify against the source page.
- Keep answers tight — crew are usually mid-show or mid-bump-in.`;

export const MAX_STEPS = 6;

export type KbSearchResult = {
  breadcrumb: string;
  title: string;
  url: string;
  score: number;
  text: string;
};

export const kbSearchTool = tool({
  description:
    "Search the ILUMINA AV Ops knowledge base. Returns the most relevant KB chunks with their source page titles and URLs. Use focused queries; search multiple times for multi-part questions.",
  inputSchema: z.object({
    query: z.string().describe("A focused search query about AV operations at ILUMINA"),
  }),
  execute: async ({ query }): Promise<KbSearchResult[] | { error: string }> => {
    try {
      const vector = await embedQuery(query);
      const hits = await searchKb(vector, 5);
      return hits.map((h) => ({
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

export const agentTools = { kb_search: kbSearchTool };
