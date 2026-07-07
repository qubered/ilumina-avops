"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const buttonClass =
  "h-7 rounded border border-btn-neutral-border bg-btn-neutral px-2 text-[13px] font-medium text-text transition-colors duration-100 hover:bg-canvas-2 disabled:opacity-40";
const inputClass =
  "h-7 w-full rounded border border-input-border bg-input px-2 text-[13px] text-text outline-none transition-colors duration-100 focus:border-input-focus";

export function UserRow({
  userId,
  name,
  email,
  role,
  banned,
  isSelf,
  isLastAdmin,
  conversationCount,
  joined,
}: {
  userId: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  isSelf: boolean;
  isLastAdmin: boolean;
  conversationCount: number;
  joined: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(name);
  const [editEmail, setEditEmail] = useState(email);

  async function run(action: () => Promise<{ error?: { message?: string } | null }>) {
    setBusy(true);
    setError(null);
    try {
      const { error: actionError } = await action();
      if (actionError) {
        setError(actionError.message ?? "That didn't work.");
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    const nextName = editName.trim();
    const nextEmail = editEmail.trim().toLowerCase();
    if (!nextName || !nextEmail) return;
    const ok = await run(() =>
      authClient.admin.updateUser({
        userId,
        data: {
          ...(nextName !== name ? { name: nextName } : {}),
          ...(nextEmail !== email ? { email: nextEmail } : {}),
        },
      }),
    );
    if (ok) setEditing(false);
  }

  function setPassword() {
    const newPassword = prompt(
      `New temporary password for ${name} (min 8 characters). Share it with them directly; they can't reset it themselves.`,
    );
    if (newPassword === null) return;
    if (newPassword.length < 8) {
      setError("Password needs at least 8 characters.");
      return;
    }
    void run(() => authClient.admin.setUserPassword({ userId, newPassword }));
  }

  const lockedAdmin = role === "admin" && isLastAdmin && !banned;

  return (
    <tr className={`border-b border-divider ${banned ? "opacity-60" : ""}`}>
      <td className="py-2 pr-3">
        {editing ? (
          <div className="flex max-w-64 flex-col gap-1">
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className={inputClass}
              placeholder="Name"
            />
            <input
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              className={inputClass}
              placeholder="Email"
            />
          </div>
        ) : (
          <>
            <p className="font-medium text-text">
              {name}
              {isSelf && <span className="ml-1.5 text-xs text-text-3">(you)</span>}
            </p>
            <p className="text-xs text-text-3">{email}</p>
          </>
        )}
      </td>
      <td className="py-2 pr-3">
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
            banned
              ? "bg-danger/10 text-danger"
              : role === "admin"
                ? "bg-accent/10 text-link"
                : "bg-canvas-2 text-text-2"
          }`}
        >
          {banned ? "suspended" : role}
        </span>
      </td>
      <td className="py-2 pr-3 text-text-2">{conversationCount}</td>
      <td className="py-2 pr-3 text-text-2">{joined}</td>
      <td className="py-2 text-right">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {error && <span className="text-xs text-danger">{error}</span>}
          {editing ? (
            <>
              <button type="button" disabled={busy} className={buttonClass} onClick={saveEdit}>
                Save
              </button>
              <button
                type="button"
                disabled={busy}
                className={buttonClass}
                onClick={() => {
                  setEditing(false);
                  setEditName(name);
                  setEditEmail(email);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                title="Edit name and email"
                className={buttonClass}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              {!isSelf && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    title="Set a temporary password"
                    className={buttonClass}
                    onClick={setPassword}
                  >
                    Set password
                  </button>
                  {!banned && (
                    <button
                      type="button"
                      disabled={busy || lockedAdmin}
                      title={
                        lockedAdmin ? "The last admin can't be demoted" : undefined
                      }
                      className={buttonClass}
                      onClick={() =>
                        run(() =>
                          authClient.admin.setRole({
                            userId,
                            // Server accepts our role set; client types only
                            // know the plugin's default union.
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
                    disabled={busy || lockedAdmin}
                    title={banned ? "Restore access" : "Block sign-in, keep history"}
                    className={buttonClass}
                    onClick={() =>
                      run(() =>
                        banned
                          ? authClient.admin.unbanUser({ userId })
                          : authClient.admin.banUser({
                              userId,
                              banReason: "Suspended by admin",
                            }),
                      )
                    }
                  >
                    {banned ? "Restore" : "Suspend"}
                  </button>
                  <button
                    type="button"
                    disabled={busy || lockedAdmin}
                    title="Delete the account and all of its conversations"
                    className={`${buttonClass} hover:text-danger`}
                    onClick={() => {
                      if (
                        !confirm(
                          "Remove this account and all of its conversations? This can't be undone.",
                        )
                      )
                        return;
                      void run(() => authClient.admin.removeUser({ userId }));
                    }}
                  >
                    Remove
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
