import { stepCountIs, streamText, type ModelMessage, type UIMessage } from "ai";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { conversations, db, messages, type Source } from "@/lib/db";
import {
  agentTools,
  getChatModel,
  MAX_STEPS,
  SYSTEM_PROMPT,
  systemPromptOptions,
  type KbSearchResult,
} from "@/lib/rag/agent";

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

/** Collect deduped sources from kb_search results, preferring ones cited in the answer. */
function collectSources(steps: Array<{ toolResults?: unknown[] }>, answer: string): Source[] {
  const all: Source[] = [];
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const r = result as { toolName?: string; output?: KbSearchResult[] };
      if (r.toolName !== "kb_search" || !Array.isArray(r.output)) continue;
      for (const hit of r.output) {
        if (hit?.title && hit?.url) all.push({ title: hit.title, url: hit.url });
      }
    }
  }
  const deduped = [...new Map(all.map((s) => [s.url, s])).values()];
  const cited = deduped.filter((s) => answer.includes(s.url) || answer.includes(s.title));
  return cited.length > 0 ? cited : deduped;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve the model first: misconfigured provider (e.g. expired Codex
  // login) becomes a clear 503, never a hang.
  let model;
  try {
    model = await getChatModel();
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
      model,
      ...systemPromptOptions(SYSTEM_PROMPT),
      messages: modelMessages,
      tools: agentTools,
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
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));
      },
      onError: (error) => {
        console.error("[chat] stream error:", error);
      },
    });

    return result.toUIMessageStreamResponse({
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
