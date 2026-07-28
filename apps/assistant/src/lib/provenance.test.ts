import { describe, expect, it } from "vitest";
import type { ProvenanceChip } from "@mort/core/memory/provenance";
import { collectProvenance } from "./provenance";

const chip = (over: Partial<ProvenanceChip> = {}): ProvenanceChip => ({
  kind: "fact",
  subject: "led-wall-height",
  value: "6m",
  who: "Jayden",
  when: "2026-07-23",
  via: "chat",
  conversationId: "c-1",
  messageId: "m-1",
  sourceId: null,
  ...over,
});

const factStep = (...chips: ProvenanceChip[]) => ({
  toolResults: [
    { toolName: "current_state", output: { facts: chips.map((c) => ({ value: c.value, provenance: c })) } },
  ],
});

describe("collectProvenance", () => {
  it("chips a fact the answer actually used", () => {
    const out = collectProvenance([factStep(chip())], "LED wall's at 6m on the Main Stage.");
    expect(out).toHaveLength(1);
    expect(out[0].who).toBe("Jayden");
  });

  it("drops facts the tool offered but the answer never used", () => {
    const used = chip();
    const unused = chip({ subject: "house-lights-preset", value: "Preset 4" });
    const out = collectProvenance([factStep(used, unused)], "LED wall's at 6m.");
    expect(out.map((c) => c.subject)).toEqual(["led-wall-height"]);
  });

  it("never falls back to chipping everything when nothing was cited", () => {
    // Sources degrade to "show them all"; attribution must not — a chip saying
    // Jayden told him something he didn't say is worse than no chip.
    const out = collectProvenance([factStep(chip())], "Nothing in the KB covers that, sorry.");
    expect(out).toEqual([]);
  });

  it("matches a slug key against the prose an answer actually writes", () => {
    const out = collectProvenance(
      [factStep(chip({ value: "somewhere around six metres" }))],
      "The LED wall height is set by Jayden's call.",
    );
    expect(out).toHaveLength(1);
  });

  it("reads event_log's bare array as well as current_state's object", () => {
    const events = {
      toolResults: [
        {
          toolName: "event_log",
          output: [
            {
              action: "Raised LED wall to 6m",
              provenance: chip({ kind: "event", subject: "Raised LED wall to 6m", value: null, who: null, via: "file", sourceId: "Ops/actions.xlsx" }),
            },
          ],
        },
      ],
    };
    const out = collectProvenance([events], "Log says: raised LED wall to 6m on the 23rd.");
    expect(out).toHaveLength(1);
    expect(out[0].via).toBe("file");
  });

  it("includes superseded values when the answer recites the history", () => {
    const step = {
      toolResults: [
        {
          toolName: "current_state",
          output: {
            facts: [{ provenance: chip() }],
            history: [{ previously: [{ provenance: chip({ value: "2.5m", who: "Sam", messageId: "m-0" }) }] }],
          },
        },
      ],
    };
    const out = collectProvenance([step], "It's 6m now — was 2.5m before that.");
    expect(out.map((c) => c.value)).toEqual(["6m", "2.5m"]);
  });

  it("ignores other tools' results entirely", () => {
    const step = { toolResults: [{ toolName: "kb_search", output: [{ provenance: chip() }] }] };
    expect(collectProvenance([step], "LED wall's at 6m.")).toEqual([]);
  });

  it("survives a tool that errored instead of returning rows", () => {
    const step = { toolResults: [{ toolName: "current_state", output: { note: "nothing covers that" } }] };
    expect(collectProvenance([step], "6m")).toEqual([]);
    expect(collectProvenance([{}], "6m")).toEqual([]);
  });

  it("dedupes the same fact seen across two tool calls", () => {
    const out = collectProvenance([factStep(chip()), factStep(chip())], "LED wall's at 6m.");
    expect(out).toHaveLength(1);
  });
});
