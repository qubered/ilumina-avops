"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { ThemeToggle } from "./theme-toggle";

type ConversationRow = { id: string; title: string; updatedAt: string };

export function Sidebar({
  user,
  outlineUrl,
}: {
  user: { name: string; email: string; role: string };
  outlineUrl: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationRow[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const refresh = useCallback(() => {
    fetch("/api/conversations")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setConversations(data.conversations);
      })
      .catch(() => {
        // sidebar is non-critical; leave stale state
      });
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("conversations:changed", refresh);
    return () => window.removeEventListener("conversations:changed", refresh);
  }, [refresh]);

  async function handleRename(id: string) {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    refresh();
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this conversation?")) return;
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (pathname === `/c/${id}`) router.push("/");
    refresh();
  }

  async function handleSignOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  const initial = (user.name || "?").charAt(0).toUpperCase();

  return (
    <aside className="flex w-[260px] shrink-0 flex-col bg-sidebar">
      {/* Workspace row, set like Outline's team name */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <Link
          href="/"
          className="rounded font-brand text-[16px] font-semibold text-text"
        >
          ILUMINA AV Ops
        </Link>
        <a
          href={outlineUrl}
          target="_blank"
          rel="noreferrer"
          title="Open the wiki"
          className="rounded p-1 text-sidebar-text transition-colors duration-100 hover:bg-sidebar-hover hover:text-text"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        </a>
      </div>

      <div className="px-3 pb-1">
        <Link
          href="/"
          className="flex h-8 w-full items-center gap-2 rounded border border-btn-neutral-border bg-btn-neutral px-3 text-sm font-medium text-text transition-colors duration-100 hover:bg-canvas-2"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <p className="px-2 pb-1 text-[13px] font-medium text-sidebar-text">
          Conversations
        </p>
        {conversations === null ? null : conversations.length === 0 ? (
          <p className="px-2 py-1 text-sm text-sidebar-text">
            Ask something to start one
          </p>
        ) : (
          <ul>
            {conversations.map((c) => {
              const active = pathname === `/c/${c.id}`;
              return (
                <li key={c.id} className="group relative">
                  {renamingId === c.id ? (
                    <input
                      autoFocus
                      className="my-px h-8 w-full rounded border border-input-focus bg-canvas px-2 text-[15px] text-text outline-none"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => handleRename(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRename(c.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <Link
                      href={`/c/${c.id}`}
                      className={`flex h-8 items-center truncate rounded px-2 pr-14 text-[15px] transition-colors duration-100 ${
                        active
                          ? "bg-sidebar-active font-medium text-text"
                          : "text-sidebar-text hover:bg-sidebar-hover hover:text-text"
                      }`}
                    >
                      <span className="truncate">{c.title}</span>
                    </Link>
                  )}
                  {renamingId !== c.id && (
                    <span className="absolute top-1/2 right-1 hidden -translate-y-1/2 gap-0.5 group-hover:flex group-focus-within:flex">
                      <button
                        type="button"
                        title="Rename"
                        onClick={() => {
                          setRenamingId(c.id);
                          setRenameValue(c.title);
                        }}
                        className="rounded p-1 text-sidebar-text transition-colors duration-100 hover:bg-sidebar-active hover:text-text"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        onClick={() => handleDelete(c.id)}
                        className="rounded p-1 text-sidebar-text transition-colors duration-100 hover:bg-sidebar-active hover:text-danger"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        </svg>
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <div className="px-3 py-3">
        {user.role === "admin" && (
          <Link
            href="/admin"
            className={`mb-1 flex h-8 items-center gap-2 rounded px-2 text-sm transition-colors duration-100 ${
              pathname === "/admin"
                ? "bg-sidebar-active font-medium text-text"
                : "text-sidebar-text hover:bg-sidebar-hover hover:text-text"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Admin
          </Link>
        )}
        <div className="flex items-center gap-2 px-1 pt-1">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-medium text-accent-fg">
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text">{user.name}</p>
            <p className="truncate text-xs text-text-3">{user.email}</p>
          </div>
          <ThemeToggle />
          <button
            type="button"
            onClick={handleSignOut}
            title="Sign out"
            className="rounded p-1 text-sidebar-text transition-colors duration-100 hover:bg-sidebar-hover hover:text-text"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}
