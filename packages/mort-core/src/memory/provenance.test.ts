import { describe, expect, it } from "vitest";
import type { MortFact } from "./index";
import { describeProvenance, eventChip, factChip, formatProvenanceDate } from "./provenance";

const fact = (over: Partial<MortFact> = {}): MortFact => ({
  id: 1,
  factKey: "led-wall-height",
  value: "6m",
  scope: "Main Stage",
  effectiveFrom: "2026-07-20",
  effectiveTo: null,
  sourceTier: "human",
  approvedBy: "Jayden",
  confidence: "approved",
  note: null,
  createdAt: "2026-07-23T04:15:00.000Z",
  taughtVia: "chat",
  conversationId: "c-1",
  messageId: "m-1",
  supersedes: null,
  ...over,
});

describe("formatProvenanceDate", () => {
  it("renders an ISO date the way a person says it", () => {
    expect(formatProvenanceDate("2026-07-23")).toBe("23 Jul 2026");
    expect(formatProvenanceDate("2026-07-23T04:15:00.000Z")).toBe("23 Jul 2026");
  });

  it("returns null rather than a guess for anything unparseable", () => {
    expect(formatProvenanceDate(null)).toBeNull();
    expect(formatProvenanceDate("last Tuesday")).toBeNull();
    expect(formatProvenanceDate("2026-13-01")).toBeNull();
  });
});

describe("factChip", () => {
  it("dates the TELLING, not the taking effect", () => {
    // A fact can be taught today about a change that happened last week; the
    // chip's claim is about the conversation, so it follows created_at.
    const chip = factChip(fact({ effectiveFrom: "2026-07-20" }));
    expect(chip.when).toBe("2026-07-23");
    expect(chip.via).toBe("chat");
    expect(chip.conversationId).toBe("c-1");
    expect(chip.messageId).toBe("m-1");
  });

  it("carries the console through as its own door", () => {
    const chip = factChip(fact({ taughtVia: "admin", conversationId: null, messageId: null }));
    expect(chip.via).toBe("admin");
    expect(chip.conversationId).toBeNull();
  });
});

describe("eventChip", () => {
  it("a reported event names its reporter", () => {
    const chip = eventChip({
      actionText: "Raised LED wall to 6m",
      occurredOn: "2026-07-23",
      sourceId: "chat:c-1",
      reportedBy: "Jayden",
      conversationId: "c-1",
    });
    expect(chip.via).toBe("chat");
    expect(chip.who).toBe("Jayden");
  });

  it("a spreadsheet row is attributed to the file, not to a person", () => {
    const chip = eventChip({
      actionText: "Ran SDI under floor",
      occurredOn: "2026-07-12",
      sourceId: "Ops/actions.xlsx",
    });
    expect(chip.via).toBe("file");
    expect(chip.who).toBeNull();
    expect(chip.sourceId).toBe("Ops/actions.xlsx");
  });
});

describe("describeProvenance", () => {
  it("is the sentence Mort says back", () => {
    expect(describeProvenance(factChip(fact()))).toBe("Jayden told me — on 23 Jul 2026 — in chat");
  });

  it("names the file when nobody told him", () => {
    const chip = eventChip({
      actionText: "Ran SDI under floor",
      occurredOn: "2026-07-12",
      sourceId: "Ops/actions.xlsx",
    });
    expect(describeProvenance(chip)).toBe("recorded — on 12 Jul 2026 — from Ops/actions.xlsx");
  });

  it("omits the date rather than inventing one", () => {
    const chip = factChip(fact({ createdAt: "" }));
    expect(describeProvenance(chip)).toBe("Jayden told me — in chat");
  });
});

describe("the chat-taught chip (what P1's confirm path produces)", () => {
  it("carries teller, date and message so the answer can link back", () => {
    // Shape of a fact written by executePendingAction: attribution from the
    // session, conversation and message from the pending row.
    const taught = fact({
      approvedBy: "jayden@qubered.com",
      taughtVia: "chat",
      sourceTier: "chat",
      conversationId: "8f14e45f-ceea-467a-9575-1c1f5d1b1a11",
      messageId: "3d1a2b4c-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      createdAt: "2026-07-23T22:41:00.000Z",
    });
    const chip = factChip(taught);
    expect(chip.via).toBe("chat");
    expect(chip.conversationId).toBe("8f14e45f-ceea-467a-9575-1c1f5d1b1a11");
    expect(chip.messageId).toBe("3d1a2b4c-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
    expect(describeProvenance(chip)).toBe("jayden@qubered.com told me — on 23 Jul 2026 — in chat");
  });

  it("a superseded row keeps its own teller, not the new one's", () => {
    // The history chain has to attribute each step separately, or "who
    // changed it?" collapses into "whoever touched it last".
    const before = factChip(fact({ id: 1, value: "2.5m", approvedBy: "Sam", createdAt: "2026-07-12T01:00:00.000Z" }));
    const after = factChip(fact({ id: 2, value: "6m", approvedBy: "Jayden", supersedes: 1 }));
    expect(before.who).toBe("Sam");
    expect(after.who).toBe("Jayden");
    expect(formatProvenanceDate(before.when)).toBe("12 Jul 2026");
  });
});
