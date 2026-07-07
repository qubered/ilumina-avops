"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/feedback", label: "Feedback" },
] as const;

export function AdminTabs() {
  const pathname = usePathname();
  return (
    <nav className="mt-4 flex gap-1 border-b border-divider">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors duration-100 ${
              active
                ? "border-accent font-medium text-text"
                : "border-transparent text-text-2 hover:text-text"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
