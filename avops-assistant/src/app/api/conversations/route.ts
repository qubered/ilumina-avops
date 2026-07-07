import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { streamText } from "ai";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { conversations, db } from "@/lib/db";
import { getChatModel } from "@/lib/rag/agent";

function fallbackTitle(firstMessage: string): string {
  const words = firstMessage.trim().split(/\s+/).slice(0, 8).join(" ");
  return words.length > 60 ? `${words.slice(0, 57)}...` : words || "New conversation";
}

async function generateTitle(firstMessage: string): Promise<string> {
  try {
    // streamText, not generateText: the Codex backend (AI_PROVIDER=codex)
    // only accepts streaming requests.
    const result = streamText({
      model: await getChatModel(),
      prompt: `Write a 3-6 word title for a chat that starts with this question. Reply with the title only, no quotes.\n\nQuestion: ${firstMessage.slice(0, 500)}`,
      abortSignal: AbortSignal.timeout(6000),
      maxOutputTokens: 200,
    });
    const title = (await result.text).trim().replace(/^["']|["']$/g, "");
    return title || fallbackTitle(firstMessage);
  } catch {
    return fallbackTitle(firstMessage);
  }
}

export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      pinned: conversations.pinned,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(and(eq(conversations.userId, session.user.id), eq(conversations.isWidget, false)))
    .orderBy(desc(conversations.pinned), desc(conversations.updatedAt));

  return NextResponse.json({ conversations: rows });
}

const createSchema = z.object({
  firstMessage: z.string().min(1).max(4000),
});

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "firstMessage is required" }, { status: 400 });
  }

  const title = await generateTitle(parsed.data.firstMessage);
  const [conversation] = await db
    .insert(conversations)
    .values({ userId: session.user.id, title })
    .returning();

  return NextResponse.json({ conversation }, { status: 201 });
}
