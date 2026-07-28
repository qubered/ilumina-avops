import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolContext } from "./cards";
import type { ActingUser } from "./pending-actions";

/**
 * The write:kb routing, against fakes.
 *
 * What's under test is the promise the whole feature rests on: a tool call
 * NEVER writes. It either parks a card for a human to confirm, queues a
 * proposal for review, or refuses — and which of the three depends on role,
 * mode and the target, not on how the conversation went.
 */

const state = vi.hoisted(() => ({
  chatWrites: null as string | null,
  mode: "live" as string,
  threshold: 0.6,
  raisedToday: 0,
  preview: null as Record<string, unknown> | null,
}));

const parked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const reviewed = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../memory", () => ({
  enqueueReview: async (item: Record<string, unknown>) => {
    reviewed.push(item);
    return true;
  },
}));

// The chat-writes kill switch is read through memory/settings (P4 split it out
// of memory/index so the spend ledger and the policy could share it).
vi.mock("../memory/settings", () => ({
  getSetting: async (key: string) => (key === "chat_writes" ? state.chatWrites : null),
}));

vi.mock("../memory/config", () => ({
  getEffectiveMode: async () => state.mode,
  getEffectiveThreshold: async () => state.threshold,
}));

vi.mock("../memory/pending", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../memory/pending")>()),
  countPendingActionsToday: async () => state.raisedToday,
  createPendingAction: async (input: Record<string, unknown>) => {
    parked.push(input);
    return { id: `pending-${parked.length}`, ...input };
  },
}));

vi.mock("../kb/chat-write", () => ({
  chatSourceId: (id: string | null) => `chat:${id ?? "adhoc"}`,
  previewDocEdit: async () => state.preview,
}));

vi.mock("../kb/outline", () => ({
  getDocumentOrNull: async (id: string) => ({ id, title: "Camera Patching", text: "", url: `/doc/${id}` }),
  documentUrl: (doc: { url: string }) => doc.url,
}));

vi.mock("./dump", () => ({
  splitDump: async () => ({ split: { pages: [], facts: [], events: [] } }),
  placeDumpPage: async () => ({}),
}));

const { buildKbTools } = await import("./kb-tools");

const admin: ActingUser = { id: "u1", email: "jayden@qubered.com", role: "admin" };
const member: ActingUser = { id: "u2", email: "crew@qubered.com", role: "member" };

const cleanPreview = {
  targetDocId: "doc-1",
  title: "Camera Patching",
  url: "/doc/doc-1",
  before: "old",
  after: "new",
  diff: [
    { kind: "remove", text: "old" },
    { kind: "add", text: "new" },
  ],
  added: 1,
  removed: 1,
  changed: true,
  appendsNewRegion: false,
  malformed: false,
  humanEditedSince: false,
};

function tools(user: ActingUser, seen: string[] = ["doc-1"]) {
  const ctx: ChatToolContext = { user, conversationId: "conv-1", seen: new Set(seen) };
  return buildKbTools(ctx);
}

// The AI SDK types execute with a second call-options argument the tools ignore.
const run = async (t: { execute?: unknown }, args: unknown) =>
  (await (t.execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})) ?? {};

const EDIT = { targetDocId: "doc-1", regionBody: "new", rationale: "user says it's 7, not 3", confidence: 0.9 };

beforeEach(() => {
  state.chatWrites = null;
  state.mode = "live";
  state.threshold = 0.6;
  state.raisedToday = 0;
  state.preview = { ...cleanPreview };
  parked.length = 0;
  reviewed.length = 0;
});

describe("propose_doc_edit", () => {
  it("raises a card for a confident admin and writes nothing", async () => {
    const result = await run(tools(admin).propose_doc_edit, EDIT);

    expect(result.status).toBe("pending");
    expect(result.pendingId).toBe("pending-1");
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

    expect(result.status).toBe("pending");
    expect(String(result.preview)).toMatch(/no Mort section yet/i);
  });

  it("never acts on a doc id the model didn't see in a search result", async () => {
    const result = await run(tools(admin, []).propose_doc_edit, EDIT);

    expect(result.status).toBe("queued_for_review");
    // The guessed id is recorded in the rationale but not handed to a human as
    // something to act on.
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

    expect(result.error).toMatch(/already says exactly that/i);
    expect(parked).toHaveLength(0);
  });

  it("warns on the card when a human edited the page since Mort last wrote", async () => {
    state.preview = { ...cleanPreview, humanEditedSince: true };
    const result = await run(tools(admin).propose_doc_edit, EDIT);

    expect(result.warnings).toEqual([expect.stringMatching(/edited this page by hand/i)]);
  });

  it("stops raising cards once the user hits the daily limit", async () => {
    state.raisedToday = 1000;
    const result = await run(tools(admin).propose_doc_edit, EDIT);

    expect(result.error).toMatch(/daily limit/i);
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

  it("parks a preview carrying Mort's metadata header", async () => {
    const result = await run(tools(admin).create_doc, NEW_PAGE);

    expect(result.status).toBe("pending");
    const body = String((parked[0].payload as Record<string, string>).regionBody);
    expect(body).toContain("Zone: PFA");
    expect(body).toContain("System: Comms");
    expect(body).toContain("Entities: Riedel");
    expect(body).toContain("Source-Files: chat:conv-1");
    expect(body).toContain("Maintained-By: Mort");
    expect(body).toContain("## Layout");
  });

  it("queues a member's new page for review, keyed on its title", async () => {
    expect((await run(tools(member).create_doc, NEW_PAGE)).status).toBe("queued_for_review");
    expect(reviewed[0]).toMatchObject({ action: "CREATE", targetDocId: null });
    // Two pages from one dump must not collapse onto one dedupe key.
    expect(String(reviewed[0].dedupeKey)).toContain("Comms Rack — PFA");
  });
});

describe("attach_source", () => {
  it("parks a card naming the file and the page", async () => {
    const result = await run(tools(admin).attach_source, {
      targetDocId: "doc-1",
      sourceId: "Video/rack.pdf",
      rationale: "it's the rack drawing for that page",
    });

    expect(result.status).toBe("pending");
    expect(parked[0].tool).toBe("attach_source");
    expect(String(result.preview)).toContain("Video/rack.pdf");
  });

  it("won't attach to a page Mort only guessed at", async () => {
    const result = await run(tools(admin, []).attach_source, {
      targetDocId: "doc-9",
      sourceId: "Video/rack.pdf",
      rationale: "hunch",
    });

    expect(result.status).toBe("queued_for_review");
    expect(reviewed[0]).toMatchObject({ action: "ATTACH", targetDocId: null });
  });
});
