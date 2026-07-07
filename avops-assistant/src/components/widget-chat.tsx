"use client";

import { useState } from "react";
import { Chat } from "./chat";

/**
 * Widget shell: starts empty and creates a new conversation on the first
 * message, exactly like the main app's home screen. "New chat" resets to a
 * fresh conversation by remounting Chat (which clears its conversation id).
 * Widget conversations are normal conversations — they show up in the full
 * app's sidebar and can be resumed there.
 */
export function WidgetChat({ appUrl }: { appUrl: string }) {
  const [sessionKey, setSessionKey] = useState(0);

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <header className="flex items-center justify-between gap-2 bg-sidebar px-3 py-2">
        <span className="font-brand text-sm font-semibold text-text">
          ILUMINA AV Ops
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSessionKey((k) => k + 1)}
            title="New chat"
            className="flex items-center gap-1 rounded border border-btn-neutral-border bg-btn-neutral px-2 py-1 text-xs font-medium text-text transition-colors duration-100 hover:bg-canvas-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New chat
          </button>
          <a
            href={appUrl}
            target="_blank"
            rel="noreferrer"
            title="Open the full app"
            className="rounded p-1 text-text-3 transition-colors duration-100 hover:bg-canvas-2 hover:text-text"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17 17 7M7 7h10v10" />
            </svg>
          </a>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <Chat
          key={sessionKey}
          conversationId={null}
          initialMessages={[]}
          compact
        />
      </div>
    </div>
  );
}
