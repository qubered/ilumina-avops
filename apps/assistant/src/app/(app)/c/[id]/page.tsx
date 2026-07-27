import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { conversations, db, messages } from "@/lib/db";
import { Chat, type DbMessage } from "@/components/chat";

export default async function ConversationPage({
  params,
}: PageProps<"/c/[id]">) {
  const session = await requireSession();
  if (!session) redirect("/login");

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, session.user.id)))
    .limit(1);
  if (!conversation) notFound();

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(asc(messages.createdAt));

  const dbMessages: DbMessage[] = rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    sources: m.sources,
  }));

  return (
    <Chat
      key={conversation.id}
      conversationId={conversation.id}
      initialMessages={dbMessages}
    />
  );
}
