import type { ProvenanceChip } from "@mort/core/memory/provenance";
import type { MessageProvenance } from "@/lib/db/schema";

/**
 * Provenance chips for the taught knowledge an answer actually leaned on (P2).
 *
 * `current_state` and `event_log` attach a chip to every row they return, but
 * a tool offering six candidates is not the same as an answer using six — a
 * chip is a claim about THIS answer, so only chips whose subject or value
 * shows up in the finished text survive. Unlike sources there is deliberately
 * no "keep them all" fallback: an attribution for something Mort never said
 * would be a lie with a person's name on it.
 */
export function collectProvenance(
  steps: Array<{ toolResults?: unknown[] }>,
  answer: string,
): MessageProvenance[] {
  const haystack = answer.toLowerCase();
  const chips: ProvenanceChip[] = [];

  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const r = result as { toolName?: string; output?: unknown };
      if (r.toolName !== "current_state" && r.toolName !== "event_log") continue;
      for (const row of rowsOf(r.output)) {
        const chip = (row as { provenance?: ProvenanceChip })?.provenance;
        if (chip?.subject) chips.push(chip);
      }
    }
  }

  const cited = chips.filter((c) => isCited(c, haystack));
  // One chip per thing, keeping the first seen — the live fact precedes the
  // superseded ones its history block carries.
  return [...new Map(cited.map((c) => [`${c.kind}:${c.subject}:${c.value ?? ""}`, c])).values()].slice(0, 8);
}

/** event_log returns a bare array; current_state returns { facts, history? }. */
function rowsOf(output: unknown): unknown[] {
  if (Array.isArray(output)) return output;
  const o = output as { facts?: unknown[]; history?: Array<{ previously?: unknown[] }> } | null;
  if (!o) return [];
  return [...(o.facts ?? []), ...(o.history ?? []).flatMap((h) => h.previously ?? [])];
}

function isCited(chip: ProvenanceChip, haystack: string): boolean {
  const value = chip.value?.toLowerCase().trim();
  if (value && haystack.includes(value)) return true;
  // Fact keys are slugs ("led-wall-height") but an answer says "LED wall
  // height". Match on words so the claim is still recognised in prose; short
  // words are dropped because "of"/"to" match everything.
  const words = chip.subject
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  return words.length > 0 && words.every((w) => haystack.includes(w));
}
