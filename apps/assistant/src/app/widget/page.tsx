import { requireSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { WidgetChat } from "@/components/widget-chat";
import { WidgetLogin } from "@/components/widget-login";

export const dynamic = "force-dynamic";

export const metadata = { title: "AV Ops Assistant" };

/**
 * Compact chat UI loaded inside the Outline iframe (brief §9). Each ask
 * starts a new conversation, just like the main app — see WidgetChat.
 */
export default async function WidgetPage() {
  const session = await requireSession();

  if (!session) {
    return <WidgetLogin appUrl={env.APP_URL} />;
  }

  return <WidgetChat appUrl={env.APP_URL} />;
}
