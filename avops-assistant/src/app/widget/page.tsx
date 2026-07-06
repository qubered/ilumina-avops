import { and, asc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { conversations, db, messages } from "@/lib/db";
import { env } from "@/lib/env";
import { Chat, type DbMessage } from "@/components/chat";
import { WidgetLogin } from "@/components/widget-login";

export const dynamic = "force-dynamic";

export const metadata = { title: "AV Ops Assistant" };

/**
 * Compact chat UI loaded inside the Outline iframe (brief §9). Uses the
 * user's single rolling "widget" conversation.
 */
export default async function WidgetPage() {
  const session = await requireSession();

  if (!session) {
    return <WidgetLogin appUrl={env.APP_URL} />;
  }

  let [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, session.user.id),
        eq(conversations.isWidget, true),
      ),
    )
    .limit(1);

  if (!conversation) {
    [conversation] = await db
      .insert(conversations)
      .values({ userId: session.user.id, title: "Widget chat", isWidget: true })
      .returning();
  }

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
    <div className="flex h-full flex-col bg-canvas">
      <header className="flex items-center justify-between bg-sidebar px-3 py-2">
        <span className="font-brand text-base font-extralight tracking-[0.03em] text-text">
          ILUMINA <span className="italic">AV Ops</span>
        </span>
        <a
          href={env.APP_URL}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-link hover:underline"
        >
          Open the full app ↗
        </a>
      </header>
      <div className="min-h-0 flex-1">
        <Chat
          conversationId={conversation.id}
          initialMessages={dbMessages}
          compact
        />
      </div>
    </div>
  );
}
