import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { conversations, db, feedback, messages } from "@/lib/db";

const bodySchema = z.object({
  messageId: z.string().uuid(),
  rating: z.enum(["up", "down"]),
  comment: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid feedback payload" }, { status: 400 });
  }
  const { messageId, rating, comment } = parsed.data;

  // Only allow feedback on assistant messages in the user's own conversations.
  const [message] = await db
    .select({ id: messages.id, role: messages.role })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(messages.id, messageId), eq(conversations.userId, session.user.id)))
    .limit(1);
  if (!message || message.role !== "assistant") {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  await db
    .insert(feedback)
    .values({ messageId, userId: session.user.id, rating, comment: comment ?? null })
    .onConflictDoUpdate({
      target: [feedback.messageId, feedback.userId],
      set: { rating, comment: comment ?? null, createdAt: new Date() },
    });

  return NextResponse.json({ ok: true });
}
