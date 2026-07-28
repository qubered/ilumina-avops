import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActingUser } from "./policy";

/**
 * The write tools' routing, against fakes. What's under test is the promise the
 * whole feature rests on: a tool call NEVER writes. It either parks a payload
 * for a human to confirm, queues a proposal for review, or refuses — and which
 * of the three depends on role, mode and the target, not on the conversation.
 */

const state = vi.hoisted(() => ({
  chatWrites: null as string | null,
  mode: "live" as string,
  threshold: 0.6,
  pendingToday: 0,
  preview: null as Record<string, unknown> | null,
}));

const parked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const reviewed = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../memory", () => ({
  getSetting: async (key: string) => (key === "chat_writes" ? state.chatWrites : null),
  enqueueReview: async (item: Record<string, unknown>) => {
    reviewed.push(item);
    return true;
  },
}));

vi.mock("../memory/config", () => ({
  getEffectiveMode: async () => state.mode,
  getEffectiveThreshold: async () => state.threshold,
}));

vi.mock("../memory/pending", () => ({
  PENDING_DAILY_CAP: 30,
  countPendingCreatedToday: async () => state.pendingToday,
  createPendingAction: async (input: Record<string, unknown>) => {
    parked.push(input);
    return { id: `pending-${parked.length}`, ...input };
  },
  getPendingAction: async () => null,
  claimPendingAction: async () => null,
  releasePendingAction: async () => {},
  listPendingActions: async () => [],
  expireStalePendingActions: async () => 0,
}));

vi.mock("../kb/chat-write", () => ({
  chatSourceId: (id: string | null) => `chat:${id ?? "adhoc"}`,
  executePendingAction: async () => ({ tool: "apply_doc_edit", summary: "done" }),
  previewDocEdit: async () => state.preview,
}));

vi.mock("../kb/outline", () => ({
  getDocumentOrNull: async (id: string) => ({ id, title: "Camera Patching", text: "", url: `/doc/${id}` }),
  documentUrl: (doc: { url: string }) => doc.url,
}));

vi.mock("../agent/dump", () => ({ splitDump: async () => ({ split: { pages: [], facts: [], events: [] } }), placeDumpPage: async () => ({}) }));

const { buildKbWriteTools } = await import("./kb-write");

const admin: ActingUser = { id: "u1", label: "jayden@qubered.com", role: "admin" };
const member: ActingUser = { id: "u2", label: "crew@qubered.com", role: "member" };

const cleanPreview = {
  targetDocId: "doc-1",
  title: "Camera Patching",
  url: "/doc/doc-1",
  before: "old",
  after: "new",
  diff: [{ kind: "remove", text: "old" }, { kind: "add", text: "new" }],
  added: 1,
  removed: 1,
  changed: true,
  appendsNewRegion: false,
  malformed: false,
  humanEditedSince: false,
};

function tools(user: ActingUser, seen: string[] = ["doc-1"]) {
  return buildKbWriteTools({ user, conversationId: "conv-1", seen: new Set(seen) });
}

// The AI SDK types execute with a second call-options argument the tools ignore.
const run = async (t: { execute?: unknown }, args: unknown) =>
  (await (t.execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})) ?? {};

const EDIT = { targetDocId: "doc-1", regionBody: "new", rationale: "user says it's 7 not 3", confidence: 0.9 };

beforeEach(() => {
  state.chatWrites = null;
  state.mode = "live";
  state.threshold = 0.6;
  state.pendingToday = 0;
  state.preview = { ...cleanPreview };
  parked.length = 0;
  reviewed.length = 0;
});

describe("propose_doc_edit", () => {
  it("parks a confirmation card for a confident admin and writes nothing", async () => {
    const result = await run(tools(admin).propose_doc_edit, EDIT);

    expect(result.status).toBe("pending_confirmation");
    expect(result.diff).toEqual(cleanPreview.diff);
    expect(parked).toHaveLength(1);
    expect(parked[0].tool).toBe("apply_doc_edit");
    expect(reviewed).toHaveLength(0);
  });

  it("sends a member's correction to the review queue instead", async () => {
    const result = await run(tools(member).propose_doc_edit, EDIT);

    expect(result.status).toBe("queued_for_review");
    expect(parked).toHaveLength(0);
    expect(reviewed[0]).toMatchObject({ action: "UPDATE_ADDITIVE", targetDocId: "doc-1" });
    expect(reviewed[0].rationale).toContain("crew@qubered.com");
  });

  it("routes a page with a malformed Mort region to review, whoever asks", async () => {
    state.preview = { ...cleanPreview, malformed: true };
    const result = await run(tools(admin).propose_doc_edit, EDIT);

    expect(result.status).toBe("queued_for_review");
    expect(reviewed[0].rationale).toContain("malformed");
    expect(parked).toHaveLength(0);
  });

  it("proposes a card for a page Mort has never touched — the region is appended, not forced to review", async () => {
    state.preview = { ...cleanPreview, appendsNewRegion: true, before: "", removed: 0 };
    const result = await run(tools(admin).propose_doc_edit, EDIT);

    expect(result.status).toBe("pending_confirmation");
    expect(String(result.preview)).toMatch(/no Mort section yet/i);
  });

  it("never acts on a doc id the model didn't see in a search result", async () => {
    const result = await run(tools(admin, []).propose_doc_edit, EDIT);

    expect(result.status).toBe("queued_for_review");
    // The guessed id is recorded in the rationale but not handed to the human
    // as something to act on.
    expect(reviewed[0].targetDocId).toBeNull();
    expect(reviewed[0].rationale).toContain("guessed");
  });

  it("shadow mode turns an admin's edit into a proposal", async () => {
    state.mode = "shadow";
    expect((await run(tools(admin).propose_doc_edit, EDIT)).status).toBe("queued_for_review");
  });

  it("refuses outright when chat writes are switched off", async () => {
    state.chatWrites = "off";
    const result = await run(tools(admin).propose_doc_edit, EDIT);

    expect(result.status).toBe("blocked");
    expect(parked).toHaveLength(0);
    expect(reviewed).toHaveLength(0);
  });

  it("says so rather than proposing a no-op when the page already says that", async () => {
    state.preview = { ...cleanPreview, changed: false, added: 0, removed: 0 };
    const result = await run(tools(admin).propose_doc_edit, EDIT);

    expect(result.status).toBe("error");
    expect(parked).toHaveLength(0);
  });

  it("warns on the card when a human edited the page since Mort last wrote", async () => {
    state.preview = { ...cleanPreview, humanEditedSince: true };
    const result = await run(tools(admin).propose_doc_edit, EDIT);

    expect(result.warnings).toEqual([expect.stringMatching(/edited this page by hand/i)]);
  });

  it("stops proposing once the user hits the daily cap", async () => {
    state.pendingToday = 30;
    const result = await run(tools(admin).propose_doc_edit, EDIT);

    expect(result.status).toBe("blocked");
    expect(parked).toHaveLength(0);
  });
});

describe("create_doc", () => {
  const NEW_PAGE = {
    title: "Comms Rack — PFA",
    collection: "Networking",
    body: "## Layout\n\nTwo racks.",
    zone: ["PFA"],
    system: ["Comms"],
    entities: ["Riedel"],
    docType: "Reference",
    rationale: "nothing in the KB covers it",
    confidence: 0.9,
  };

  it("parks a preview card carrying Mort's metadata header", async () => {
    const result = await run(tools(admin).create_doc, NEW_PAGE);

    expect(result.status).toBe("pending_confirmation");
    const body = String(parked[0].payload && (parked[0].payload as Record<string, string>).regionBody);
    expect(body).toContain("Zone: PFA");
    expect(body).toContain("System: Comms");
    expect(body).toContain("Source-Files: chat:conv-1");
    expect(body).toContain("Maintained-By: Mort");
    expect(body).toContain("## Layout");
  });

  it("queues a member's new page for review", async () => {
    expect((await run(tools(member).create_doc, NEW_PAGE)).status).toBe("queued_for_review");
    expect(reviewed[0]).toMatchObject({ action: "CREATE", targetDocId: null });
  });
});

describe("save_fact and log_event", () => {
  it("confirm-first for a member too — memory is Mort's own reversible state", async () => {
    const result = await run(tools(member).save_fact, {
      factKey: "LED wall height",
      value: "6m",
      scope: "Main Stage",
      effectiveFrom: "2026-07-23",
      note: null,
    });

    expect(result.status).toBe("pending_confirmation");
    expect(parked[0].tool).toBe("save_fact");
  });

  it("flags an undated event on the card rather than inventing a date", async () => {
    const result = await run(tools(admin).log_event, {
      actionText: "Ran SDI under the floor",
      occurredOn: null,
      event: null,
      zone: [],
      system: [],
      entities: [],
    });

    expect(result.warnings).toEqual([expect.stringMatching(/no date/i)]);
  });
});
