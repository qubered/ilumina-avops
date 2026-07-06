import { stepCountIs, streamText, type ModelMessage, type UIMessage } from "ai";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { conversations, db, messages, type Source } from "@/lib/db";
import {
  agentTools,
  getChatStack,
  MAX_STEPS,
  SYSTEM_PROMPT,
  systemPromptOptions,
  type KbSearchResult,
} from "@/lib/rag/agent";
import { mergeSources, parseTrailingSources } from "@/lib/rag/sources";
import { getStreamContext } from "@/lib/streams";
import { env } from "@/lib/env";
import { randomUUID } from "node:crypto";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";

export const maxDuration = 120;

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  message: z.object({
    role: z.literal("user"),
    parts: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  }),
});

const HISTORY_LIMIT = 20;

function extractText(parts: { type: string; text?: string }[]): string {
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Collect deduped sources: KB pages from kb_search results (preferring ones
 * cited in the answer) plus web citations from provider-executed search.
 */
function collectSources(
  steps: Array<{
    toolResults?: unknown[];
    sources?: Array<{ sourceType?: string; url?: string; title?: string }>;
  }>,
  answer: string,
): Source[] {
  const kb: Source[] = [];
  const web: Source[] = [];
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const r = result as { toolName?: string; output?: KbSearchResult[] };
      if (r.toolName !== "kb_search" || !Array.isArray(r.output)) continue;
      for (const hit of r.output) {
        if (hit?.title && hit?.url) kb.push({ title: hit.title, url: hit.url, kind: "kb" });
      }
    }
    for (const source of step.sources ?? []) {
      if (source.sourceType === "url" && source.url) {
        web.push({
          title: source.title || new URL(source.url).hostname,
          url: source.url,
          kind: "web",
        });
      }
    }
  }
  const dedupedKb = [...new Map(kb.map((s) => [s.url, s])).values()];
  const citedKb = dedupedKb.filter((s) => answer.includes(s.url) || answer.includes(s.title));
  const dedupedWeb = [...new Map(web.map((s) => [s.url, s])).values()].slice(0, 6);
  // The model's own trailing Sources list backstops providers whose web
  // search returns no citation annotations (e.g. the Codex backend) — the
  // UI strips that list, so anything in it must be captured here.
  const fromText = parseTrailingSources(answer, env.OUTLINE_URL);
  return mergeSources(citedKb.length > 0 ? citedKb : dedupedKb, dedupedWeb, fromText);
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve the model first: misconfigured provider (e.g. expired Codex
  // login) becomes a clear 503, never a hang.
  let stack;
  try {
    stack = await getChatStack();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "AI backend is not configured." },
      { status: 503 },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { conversationId, message } = parsed.data;
  const userText = extractText(message.parts);
  if (!userText) {
    return NextResponse.json({ error: "Empty message" }, { status: 400 });
  }

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, session.user.id)))
    .limit(1);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  // History from the DB (client only sends the newest message).
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_LIMIT)
    .then((rows) => rows.reverse());

  const modelMessages: ModelMessage[] = [
    ...history.map((m) => ({ role: m.role, content: m.content }) as ModelMessage),
    { role: "user", content: userText },
  ];

  // Persist the user message up front so history survives a dropped stream.
  await db.insert(messages).values({
    conversationId,
    role: "user",
    content: userText,
  });

  try {
    const result = streamText({
      model: stack.model,
      ...systemPromptOptions(SYSTEM_PROMPT),
      messages: modelMessages,
      tools: { ...agentTools, ...stack.providerTools },
      stopWhen: stepCountIs(MAX_STEPS),
      onFinish: async ({ text, steps }) => {
        const sources = collectSources(steps, text);
        await db.insert(messages).values({
          conversationId,
          role: "assistant",
          content: text,
          sources,
        });
        await db
          .update(conversations)
          .set({ updatedAt: new Date(), activeStreamId: null })
          .where(eq(conversations.id, conversationId));
      },
      onError: (error) => {
        console.error("[chat] stream error:", error);
      },
    });

    // Keep generating even if the browser disconnects (tab closed, user
    // switched conversations): drains a teed copy of the stream so onFinish
    // always runs and the answer is persisted. The client picks it up from
    // the DB when the conversation is reopened.
    void result.consumeStream({
      onError: (error) => console.error("[chat] background consume error:", error),
    });

    const streamContext = getStreamContext();

    return result.toUIMessageStreamResponse({
      // Stream web citations to the client as source parts.
      sendSources: true,
      // With Redis available, publish a tee of the SSE stream so a client
      // that disconnected (tab close / conversation switch) can reattach
      // mid-answer via GET (see below).
      ...(streamContext
        ? {
            consumeSseStream: async ({ stream }: { stream: ReadableStream<string> }) => {
              const streamId = randomUUID();
              await db
                .update(conversations)
                .set({ activeStreamId: streamId })
                .where(eq(conversations.id, conversationId));
              await streamContext.createNewResumableStream(streamId, () => stream);
            },
          }
        : {}),
      // Message ids are DB-generated; the client refetches on reload anyway.
      onError: (error) => {
        console.error("[chat] response error:", error);
        return "The assistant hit an error answering this. Check that Qdrant and the Anthropic API are reachable, then try again.";
      },
    });
  } catch (error) {
    console.error("[chat] failed to start stream:", error);
    return NextResponse.json(
      { error: "The AI backend is unreachable right now. Try again shortly." },
      { status: 502 },
    );
  }
}

export type ChatUIMessage = UIMessage;

/**
 * Resume an in-flight answer: returns the live SSE stream for the
 * conversation's active generation, 204 when there is nothing to resume
 * (no Redis, no active stream, or the stream already finished — the
 * persisted answer is in the conversation payload instead).
 */
export async function GET(req: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const conversationId = searchParams.get("conversationId");
  if (!conversationId || !z.string().uuid().safeParse(conversationId).success) {
    return NextResponse.json({ error: "Invalid conversationId" }, { status: 400 });
  }

  const streamContext = getStreamContext();
  if (!streamContext) return new Response(null, { status: 204 });

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, session.user.id)))
    .limit(1);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }
  if (!conversation.activeStreamId) return new Response(null, { status: 204 });

  const stream = await streamContext.resumeExistingStream(conversation.activeStreamId);
  if (!stream) return new Response(null, { status: 204 });

  return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
}
