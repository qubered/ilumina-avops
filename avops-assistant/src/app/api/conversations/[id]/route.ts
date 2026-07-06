import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { conversations, db, messages } from "@/lib/db";

const paramsSchema = z.object({ id: z.string().uuid() });

async function ownedConversation(id: string, userId: string) {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .limit(1);
  return conversation ?? null;
}

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/conversations/[id]">,
) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = paramsSchema.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const conversation = await ownedConversation(params.data.id, session.user.id);
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(asc(messages.createdAt));

  return NextResponse.json({ conversation, messages: rows });
}

const patchSchema = z.object({ title: z.string().min(1).max(120) });

export async function PATCH(
  req: Request,
  ctx: RouteContext<"/api/conversations/[id]">,
) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = paramsSchema.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = patchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "title is required" }, { status: 400 });

  const conversation = await ownedConversation(params.data.id, session.user.id);
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [updated] = await db
    .update(conversations)
    .set({ title: body.data.title })
    .where(eq(conversations.id, conversation.id))
    .returning();

  return NextResponse.json({ conversation: updated });
}

export async function DELETE(
  _req: Request,
  ctx: RouteContext<"/api/conversations/[id]">,
) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = paramsSchema.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const conversation = await ownedConversation(params.data.id, session.user.id);
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.delete(conversations).where(eq(conversations.id, conversation.id));
  return NextResponse.json({ ok: true });
}
