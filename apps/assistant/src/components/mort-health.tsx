"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MortChannelSpend, MortHealth } from "@/lib/mort-admin";

/** Ops surface: is the queue moving, is anything dead-lettered, what has Mort spent today. */
export function MortHealthPanel({ health }: { health: MortHealth }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);

  async function revive(id: number) {
    setBusy(id);
    try {
      await fetch("/api/admin/mort-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revive: id }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const { queue, tokensToday, dailyTokenCap, capReached, deadJobs, channels, tools } = health;

  return (
    <section className="mt-10">
      <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">Health</h2>

      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <Stat label="Queued" value={queue.pending} />
        <Stat label="Running" value={queue.running} />
        <Stat label="Dead-lettered" value={queue.dead} tone={queue.dead > 0 ? "danger" : undefined} />
        <Stat
          label="Tokens today"
          value={dailyTokenCap ? `${tokensToday.toLocaleString()} / ${dailyTokenCap.toLocaleString()}` : tokensToday.toLocaleString()}
          tone={capReached ? "danger" : undefined}
        />
        <Stat label="Tool calls today" value={tools.calls.toLocaleString()} />
        <Stat label="Refused" value={tools.refused} tone={tools.refused > 0 ? "danger" : undefined} />
      </div>

      {capReached && (
        <p className="mt-2 text-[12px] text-danger">
          Daily token cap reached — the autonomous channels have paused. Queued jobs resume tomorrow
          (or raise the cap). Chat keeps answering: it&apos;s metered, never blocked.
        </p>
      )}

      {tools.refused > 0 && (
        <p className="mt-2 text-[12px] text-danger">
          {tools.refused} tool call{tools.refused === 1 ? "" : "s"} refused by the policy tiers today — see
          the tool log below for which tool, on which channel.
        </p>
      )}

      <ChannelSpend channels={channels} />

      {deadJobs.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {deadJobs.map((j) => (
            <li key={j.id} className="rounded-md border border-divider bg-menu px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium text-text">{j.sourceId}</span>
                <span className="text-[11px] text-text-3">{j.attempts} attempts</span>
                <button
                  onClick={() => revive(j.id)}
                  disabled={busy === j.id}
                  className="ml-auto rounded border border-divider px-2 py-0.5 text-[11px] text-text-2 hover:text-text disabled:opacity-50"
                >
                  {busy === j.id ? "…" : "Retry"}
                </button>
              </div>
              {j.lastError && <p className="mt-1 line-clamp-2 text-[12px] text-danger">{j.lastError}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const CHANNEL_LABEL: Record<MortChannelSpend["channel"], string> = {
  chat: "Chat",
  ingest: "Watch folder",
  dream: "Dreaming",
};

/**
 * Where today's tokens went (P4).
 *
 * The daily cap is shared across every channel now, which makes "we hit the
 * cap" immediately raise "which channel spent it" — a question v1 couldn't
 * answer, because only ingestion was ever metered. The per-channel budgets are
 * soft: they colour a row, they don't stop work.
 */
function ChannelSpend({ channels }: { channels: MortChannelSpend[] }) {
  if (channels.every((c) => c.tokens === 0 && c.budget == null)) return null;
  return (
    <div className="mt-3">
      <p className="text-[12px] text-text-3">Today&apos;s spend by channel, and each channel&apos;s step cap.</p>
      <ul className="mt-1.5 space-y-1">
        {channels.map((c) => (
          <li
            key={c.channel}
            className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-divider bg-menu px-3 py-1.5 text-sm"
          >
            <span className="font-medium text-text">{CHANNEL_LABEL[c.channel]}</span>
            <span className={c.overBudget ? "text-danger" : "text-text-2"}>
              {c.tokens.toLocaleString()}
              {c.budget != null && ` / ${c.budget.toLocaleString()}`} tokens
            </span>
            {c.overBudget && <span className="text-[11px] text-danger">over its soft budget</span>}
            <span className="ml-auto shrink-0 text-[11px] text-text-3">max {c.maxSteps} steps/turn</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "danger" }) {
  return (
    <div className="rounded-md border border-divider bg-menu px-3 py-2">
      <div className="text-[11px] text-text-3">{label}</div>
      <div className={`text-[15px] font-semibold ${tone === "danger" ? "text-danger" : "text-text"}`}>{value}</div>
    </div>
  );
}
