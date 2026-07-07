"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Sidebar } from "./sidebar";

/**
 * Responsive shell: static sidebar beside the content on desktop, slide-over
 * drawer behind a top-bar menu button on mobile (the crew's main interface).
 */
export function AppShell({
  user,
  outlineUrl,
  children,
}: {
  user: { name: string; email: string; role: string };
  outlineUrl: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // The drawer knows which route it was opened on — navigating anywhere
  // (tapping a conversation, admin, settings) closes it by derivation.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const setOpen = (next: boolean) => setOpenedAt(next ? pathname : null);

  return (
    <div className="h-dvh md:flex">
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          aria-hidden
          onClick={() => setOpen(false)}
        />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-40 h-full transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          open ? "translate-x-0 shadow-menu" : "-translate-x-full"
        }`}
      >
        <Sidebar user={user} outlineUrl={outlineUrl} />
      </div>

      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-divider bg-canvas px-2 md:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="rounded p-2 text-text-2 transition-colors duration-100 hover:bg-canvas-2 hover:text-text"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <Link href="/" className="font-brand text-[15px] font-semibold text-text">
            ILUMINA AV Ops
          </Link>
        </header>
        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
