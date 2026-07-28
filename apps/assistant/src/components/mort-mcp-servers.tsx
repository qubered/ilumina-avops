"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { McpOverview, McpServerView, McpToolView } from "@/lib/mort-mcp";

/**
 * The MCP panel (MORT_V2_PLAN I.5) — what Mort can reach beyond his own
 * systems, and the switches that decide it.
 *
 * The layout follows the trust story rather than the data model: the master
 * freeze first, then per-server arming, then per-tool tiers. Reading down the
 * panel is reading outwards from "nothing can happen" to "this specific tool
 * may run without asking".
 */

const STATUS: Record<McpServerView["status"], { label: string; className: string }> = {
  connected: { label: "Connected", className: "text-success" },
  connecting: { label: "Connecting", className: "text-text-3" },
  error: { label: "Unreachable", className: "text-danger" },
  disabled: { label: "Disabled", className: "text-text-3" },
};

const BLANK = { name: "", transport: "streamable-http", config: '{\n  "url": "https://"\n}', description: "" };

export function MortMcpServers({ overview }: { overview: McpOverview }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(BLANK);

  async function post(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (busy) return null;
    setBusy(true);
    setError(null);
    setOutput(null);
    try {
      const res = await fetch("/api/admin/mort-mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError((json.error as string) ?? `Failed (${res.status})`);
        return null;
      }
      router.refresh();
      return json;
    } catch {
      setError("Request failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function register() {
    let config: unknown;
    try {
      config = JSON.parse(draft.config);
    } catch {
      setError("The config isn't valid JSON.");
      return;
    }
    const done = await post({
      action: "register",
      name: draft.name.trim(),
      transport: draft.transport,
      config,
      description: draft.description.trim() || null,
    });
    if (done) {
      setAdding(false);
      setDraft(BLANK);
    }
  }

  async function test(server: string, tool: string) {
    const result = await post({ action: "test", name: server, tool, args: {} });
    if (result) {
      setOutput(`${server}.${tool} → ${result.ok ? "ok" : "error"}: ${String(result.output ?? "").slice(0, 500)}`);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="border-b border-divider pb-2 text-[15px] font-semibold text-text">Connected equipment (MCP)</h2>
      <p className="mt-2 text-[13px] text-text-3">
        External tools Mort can use — a console, a PDU, anything that speaks MCP. Registering a
        server arms nothing: its tools stay off until you enable it, they are admin-only, and every
        call raises a confirmation card unless you have marked that specific tool read-only.
      </p>

      <div className="mt-3 flex items-center gap-2 rounded-md border border-divider bg-menu px-3 py-2">
        <span className="text-[13px] font-medium text-text">Connected tools</span>
        <span className="text-[12px] text-text-3">
          {overview.enabled ? "Available to admins, confirm-first." : "Frozen — no connected tool will run."}
        </span>
        <button
          onClick={() => post({ action: "master", enabled: !overview.enabled })}
          disabled={busy}
          className={`ml-auto rounded-md border border-divider px-3 py-1 text-xs transition-colors disabled:opacity-50 ${
            overview.enabled ? "bg-accent/15 font-semibold text-text" : "text-text-2 hover:text-text"
          }`}
        >
          {overview.enabled ? "Enabled" : "Frozen"}
        </button>
      </div>

      {overview.servers.length === 0 ? (
        <p className="mt-3 text-sm text-text-3">
          No MCP servers registered. Add one below — see the README for a worked example.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {overview.servers.map((server) => (
            <ServerRow key={server.name} server={server} busy={busy} post={post} onTest={test} />
          ))}
        </ul>
      )}

      {output && (
        <pre className="mt-3 max-h-48 overflow-auto rounded border border-code-border bg-code p-2 text-[12px] text-text-2">
          {output}
        </pre>
      )}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}

      {adding ? (
        <div className="mt-3 grid gap-2 rounded-md border border-divider bg-menu px-3 py-3">
          <label className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-[12px] text-text-3">Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="venue-pdu"
              className="flex-1 rounded border border-divider bg-bg px-2 py-1 text-[13px] text-text placeholder:text-text-3"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-[12px] text-text-3">Transport</span>
            <select
              value={draft.transport}
              onChange={(e) => setDraft({ ...draft, transport: e.target.value })}
              className="flex-1 rounded border border-divider bg-bg px-2 py-1 text-[13px] text-text"
            >
              <option value="streamable-http">streamable-http</option>
              <option value="sse">sse</option>
              <option value="stdio">stdio</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-[12px] text-text-3">What it is</span>
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Main Stage power distribution"
              className="flex-1 rounded border border-divider bg-bg px-2 py-1 text-[13px] text-text placeholder:text-text-3"
            />
          </label>
          <label className="flex items-start gap-2">
            <span className="w-24 shrink-0 pt-1 text-[12px] text-text-3">Config</span>
            <textarea
              value={draft.config}
              onChange={(e) => setDraft({ ...draft, config: e.target.value })}
              rows={5}
              spellCheck={false}
              className="flex-1 rounded border border-divider bg-bg px-2 py-1 font-mono text-[12px] text-text"
            />
          </label>
          <p className="text-[12px] text-text-3">
            Credentials are never stored here. Put the value in this service&apos;s environment and
            write <code className="text-text-2">&quot;Authorization&quot;: &quot;env:VENUE_PDU_TOKEN&quot;</code>{" "}
            instead — a literal in a credential-shaped field is refused.
          </p>
          <div className="flex gap-1.5">
            <button
              onClick={register}
              disabled={busy}
              className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-success hover:bg-success/10 disabled:opacity-50"
            >
              Register
            </button>
            <button
              onClick={() => setAdding(false)}
              disabled={busy}
              className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-text-2 hover:bg-canvas-2 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-3 rounded border border-divider px-2.5 py-1 text-xs font-medium text-text-2 hover:bg-canvas-2"
        >
          Add a server
        </button>
      )}
    </section>
  );
}

function ServerRow({
  server,
  busy,
  post,
  onTest,
}: {
  server: McpServerView;
  busy: boolean;
  post: (payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  onTest: (server: string, tool: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const status = STATUS[server.status];

  return (
    <li className="rounded-md border border-divider bg-menu px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setOpen((v) => !v)} className="text-sm font-medium text-text hover:underline">
          {server.name}
        </button>
        <span className="rounded border border-divider px-1.5 py-0.5 text-[11px] text-text-3">{server.transport}</span>
        <span className={`text-[11px] uppercase tracking-wide ${status.className}`}>{status.label}</span>
        {server.drifted.length > 0 && (
          <span className="rounded border border-[color:var(--highlight)] bg-[color:var(--highlight)]/15 px-1.5 py-0.5 text-[11px] text-text-2">
            {server.drifted.length} tool definition(s) changed
          </span>
        )}
        <span className="ml-auto text-[11px] text-text-3">{server.tools.length} tool(s)</span>
        <button
          onClick={() => post({ action: "toggle", name: server.name, enabled: !server.enabled })}
          disabled={busy}
          className={`rounded border border-divider px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
            server.enabled ? "bg-accent/15 font-semibold text-text" : "text-text-2 hover:text-text"
          }`}
        >
          {server.enabled ? "Enabled" : "Disabled"}
        </button>
      </div>

      {server.description && <p className="mt-1 text-[12px] text-text-3">{server.description}</p>}
      {server.lastError && <p className="mt-1 text-[12px] text-danger">{server.lastError}</p>}

      {open && (
        <div className="mt-2 border-t border-divider pt-2">
          <pre className="max-h-32 overflow-auto rounded border border-code-border bg-code p-2 text-[11px] text-text-3">
            {JSON.stringify(server.config, null, 2)}
          </pre>

          {server.tools.length === 0 ? (
            <p className="mt-2 text-[12px] text-text-3">
              {server.enabled ? "No tools discovered yet." : "Enable the server to discover its tools."}
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {server.tools.map((tool) => (
                <ToolRow key={tool.tool} server={server.name} tool={tool} busy={busy} post={post} onTest={onTest} />
              ))}
            </ul>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5">
            {server.drifted.length > 0 && (
              <button
                onClick={() => post({ action: "review", name: server.name })}
                disabled={busy}
                className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-text-2 hover:bg-canvas-2 disabled:opacity-50"
                title="Accept the current tool definitions as reviewed"
              >
                Mark reviewed
              </button>
            )}
            <button
              onClick={() => post({ action: "remove", name: server.name })}
              disabled={busy}
              className="rounded border border-divider px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function ToolRow({
  server,
  tool,
  busy,
  post,
  onTest,
}: {
  server: string;
  tool: McpToolView;
  busy: boolean;
  post: (payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  onTest: (server: string, tool: string) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded border border-divider px-2 py-1.5 text-[13px]">
      <code className="text-text-2">{tool.tool}</code>
      {tool.drifted && <span className="text-[11px] text-danger">changed since review</span>}
      <span className="min-w-0 flex-1 truncate text-[12px] text-text-3">{tool.description}</span>
      <select
        value={tool.tier}
        onChange={(e) => post({ action: "override", name: server, tool: tool.tool, tier: e.target.value })}
        disabled={busy}
        className="rounded border border-divider bg-bg px-1.5 py-0.5 text-[11px] text-text disabled:opacity-50"
        title="write:world asks for confirmation on every call; read runs directly"
      >
        <option value="write:world">write:world — confirm each call</option>
        <option value="read">read — runs directly</option>
      </select>
      <button
        onClick={() => post({ action: "override", name: server, tool: tool.tool, enabled: !tool.enabled })}
        disabled={busy}
        className="rounded border border-divider px-2 py-0.5 text-[11px] text-text-2 hover:bg-canvas-2 disabled:opacity-50"
      >
        {tool.enabled ? "On belt" : "Off belt"}
      </button>
      <button
        onClick={() => onTest(server, tool.tool)}
        disabled={busy}
        className="rounded border border-divider px-2 py-0.5 text-[11px] text-text-2 hover:bg-canvas-2 disabled:opacity-50"
        title="Call it now with no arguments"
      >
        Test
      </button>
    </li>
  );
}
