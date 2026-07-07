"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const buttonClass =
  "h-7 rounded border border-btn-neutral-border bg-btn-neutral px-2 text-[13px] font-medium text-text transition-colors duration-100 hover:bg-canvas-2 disabled:opacity-40";

export function UserActions({
  userId,
  role,
  banned,
  isSelf,
  isLastAdmin,
}: {
  userId: string;
  role: string;
  banned: boolean;
  isSelf: boolean;
  isLastAdmin: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ error?: { message?: string } | null }>) {
    setBusy(true);
    setError(null);
    try {
      const { error: actionError } = await action();
      if (actionError) setError(actionError.message ?? "That didn't work.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // Guard rails: you can't act on yourself, and the last active admin can't
  // be demoted or suspended (the server enforces admin-only; these keep the
  // UI from offering foot-guns).
  if (isSelf) return <span className="text-[13px] text-text-3">—</span>;

  return (
    <div className="flex items-center justify-end gap-1.5">
      {error && <span className="text-xs text-danger">{error}</span>}
      {!banned && (
        <button
          type="button"
          disabled={busy || (role === "admin" && isLastAdmin)}
          title={
            role === "admin"
              ? isLastAdmin
                ? "The last admin can't be demoted"
                : "Make member"
              : "Make admin"
          }
          className={buttonClass}
          onClick={() =>
            run(() =>
              authClient.admin.setRole({
                userId,
                // Server accepts our role set; the client types only know
                // the plugin's default union.
                role: (role === "admin" ? "member" : "admin") as "admin",
              }),
            )
          }
        >
          {role === "admin" ? "Make member" : "Make admin"}
        </button>
      )}
      <button
        type="button"
        disabled={busy || (role === "admin" && isLastAdmin && !banned)}
        title={banned ? "Restore access" : "Block sign-in, keep history"}
        className={buttonClass}
        onClick={() =>
          run(() =>
            banned
              ? authClient.admin.unbanUser({ userId })
              : authClient.admin.banUser({ userId, banReason: "Suspended by admin" }),
          )
        }
      >
        {banned ? "Restore" : "Suspend"}
      </button>
      <button
        type="button"
        disabled={busy || (role === "admin" && isLastAdmin && !banned)}
        title="Delete the account and all of its conversations"
        className={`${buttonClass} hover:text-danger`}
        onClick={() => {
          if (!confirm("Remove this account and all of its conversations? This can't be undone.")) return;
          run(() => authClient.admin.removeUser({ userId }));
        }}
      >
        Remove
      </button>
    </div>
  );
}
