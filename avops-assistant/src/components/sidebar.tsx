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
    // setState happens in the fetch callback (external system), not
    // synchronously in the effect.
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

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-edge bg-sidebar">
      <div className="flex items-center justify-between px-3 py-3">
        <Link
          href="/"
          className="rounded px-1 text-xs font-semibold tracking-widest text-muted hover:text-fg"
        >
          ILUMINA AV OPS
        </Link>
        <a
          href={outlineUrl}
          target="_blank"
          rel="noreferrer"
          title="Open the Outline wiki"
          className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        </a>
      </div>

      <div className="px-3 pb-2">
        <Link
          href="/"
          className="flex w-full items-center gap-2 rounded-md border border-edge bg-bg px-3 py-1.5 text-sm font-medium text-fg shadow-sm transition-colors hover:bg-hover"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-1">
        {conversations === null ? (
          <p className="px-2 py-1 text-sm text-faint">Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-1 text-sm text-faint">No conversations yet</p>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => {
              const active = pathname === `/c/${c.id}`;
              return (
                <li key={c.id} className="group relative">
                  {renamingId === c.id ? (
                    <input
                      autoFocus
                      className="w-full rounded-md border border-accent bg-bg px-2 py-1 text-sm outline-none"
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
                      className={`block truncate rounded-md px-2 py-1.5 pr-14 text-sm transition-colors ${
                        active
                          ? "bg-active font-medium text-fg"
                          : "text-muted hover:bg-hover hover:text-fg"
                      }`}
                    >
                      {c.title}
                    </Link>
                  )}
                  {renamingId !== c.id && (
                    <span className="absolute top-1/2 right-1 hidden -translate-y-1/2 gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        title="Rename"
                        onClick={() => {
                          setRenamingId(c.id);
                          setRenameValue(c.title);
                        }}
                        className="rounded p-1 text-faint hover:bg-active hover:text-fg"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        onClick={() => handleDelete(c.id)}
                        className="rounded p-1 text-faint hover:bg-active hover:text-danger"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

      <div className="border-t border-edge px-3 py-2">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{user.name}</p>
            <p className="truncate text-xs text-faint">{user.email}</p>
          </div>
          <div className="flex items-center gap-0.5">
            <ThemeToggle />
            <button
              type="button"
              onClick={handleSignOut}
              title="Sign out"
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          </div>
        </div>
        {user.role === "admin" && (
          <Link
            href="/admin"
            className={`mt-1 block rounded-md px-2 py-1 text-xs transition-colors ${
              pathname === "/admin"
                ? "bg-active text-fg"
                : "text-muted hover:bg-hover hover:text-fg"
            }`}
          >
            Admin — KB sync & feedback
          </Link>
        )}
      </div>
    </aside>
  );
}
