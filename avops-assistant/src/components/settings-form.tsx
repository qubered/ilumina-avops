"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const inputClass =
  "h-9 w-full rounded border border-input-border bg-input px-3 text-base text-text outline-none transition-colors duration-100 focus:border-input-focus md:text-[15px]";
const labelClass = "mb-1 block text-sm font-medium text-text-2";
const buttonClass =
  "h-8 rounded bg-accent px-3 text-sm font-medium text-accent-fg transition-colors duration-100 hover:bg-accent-hover disabled:opacity-50";

export function SettingsForm({ initialName, email }: { initialName: string; email: string }) {
  const router = useRouter();

  // Profile
  const [name, setName] = useState(initialName);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);

  // Password
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === initialName) return;
    setProfileBusy(true);
    setProfileMessage(null);
    try {
      const { error } = await authClient.updateUser({ name: trimmed });
      setProfileMessage(error ? (error.message ?? "That didn't work.") : "Saved");
      router.refresh();
    } finally {
      setProfileBusy(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordMessage(null);
    if (newPassword.length < 8) {
      setPasswordMessage({ kind: "error", text: "New password needs at least 8 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ kind: "error", text: "New passwords don't match." });
      return;
    }
    setPasswordBusy(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (error) {
        setPasswordMessage({
          kind: "error",
          text: error.message ?? "Password change failed — check your current password.",
        });
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMessage({
        kind: "ok",
        text: "Password changed. Other signed-in devices were signed out.",
      });
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div className="space-y-10 pb-12">
      <section>
        <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">
          Profile
        </h2>
        <form onSubmit={saveProfile} className="mt-4 max-w-sm space-y-3">
          <div>
            <label htmlFor="name" className={labelClass}>
              Name
            </label>
            <input
              id="name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </div>
          <div>
            <label className={labelClass}>Email</label>
            <p className="text-[15px] text-text-2">{email}</p>
            <p className="mt-0.5 text-[13px] text-text-3">
              Ask an admin if your email needs changing.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={profileBusy || !name.trim() || name.trim() === initialName}
              className={buttonClass}
            >
              Save
            </button>
            {profileMessage && (
              <span
                className={`text-[13px] ${profileMessage === "Saved" ? "text-text-3" : "text-danger"}`}
              >
                {profileMessage}
              </span>
            )}
          </div>
        </form>
      </section>

      <section>
        <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">
          Password
        </h2>
        <form onSubmit={changePassword} className="mt-4 max-w-sm space-y-3">
          <div>
            <label htmlFor="currentPassword" className={labelClass}>
              Current password
            </label>
            <input
              id="currentPassword"
              type="password"
              className={inputClass}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <div>
            <label htmlFor="newPassword" className={labelClass}>
              New password
            </label>
            <input
              id="newPassword"
              type="password"
              className={inputClass}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label htmlFor="confirmPassword" className={labelClass}>
              Confirm new password
            </label>
            <input
              id="confirmPassword"
              type="password"
              className={inputClass}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={passwordBusy} className={buttonClass}>
              Change password
            </button>
            {passwordMessage && (
              <span
                className={`text-[13px] ${passwordMessage.kind === "ok" ? "text-text-3" : "text-danger"}`}
              >
                {passwordMessage.text}
              </span>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
