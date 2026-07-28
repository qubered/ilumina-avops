import { NextResponse } from "next/server";
import { z } from "zod";
import { MCP_TIERS, TRANSPORTS } from "@mort/core/mcp";
import { requireAdmin } from "@/lib/auth";
import {
  acknowledgeMcpDrift,
  deleteMcpServer,
  overrideMcpTool,
  registerMcpServer,
  setMcpMasterSwitch,
  testMcpTool,
  toggleMcpServer,
} from "@/lib/mort-mcp";

/**
 * Admin-only control of the MCP harness (MORT_V2_PLAN I.5).
 *
 * `requireAdmin` is the whole authorisation story for this route, and it has to
 * be: a registered server's tools can reach real equipment, so the difference
 * between an admin and a crew member is the difference between configuring a
 * PDU and not being able to see it exists. The acting user comes from the
 * session for the journal entry, never from the body — same rule as everywhere
 * else Mort records who decided something.
 */

const body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("register"),
    name: z.string(),
    transport: z.enum(TRANSPORTS as [string, ...string[]]),
    config: z.record(z.string(), z.unknown()),
    description: z.string().max(300).nullish(),
  }),
  z.object({ action: z.literal("toggle"), name: z.string(), enabled: z.boolean() }),
  z.object({
    action: z.literal("override"),
    name: z.string(),
    tool: z.string(),
    tier: z.enum(MCP_TIERS).optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ action: z.literal("remove"), name: z.string() }),
  z.object({
    action: z.literal("test"),
    name: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ action: z.literal("review"), name: z.string() }),
  z.object({ action: z.literal("master"), enabled: z.boolean() }),
]);

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const by = session.user.email ?? session.user.id;

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const input = parsed.data;

  const result = await (() => {
    switch (input.action) {
      case "register":
        return registerMcpServer(
          { name: input.name, transport: input.transport, config: input.config, description: input.description },
          by,
        );
      case "toggle":
        return toggleMcpServer(input.name, input.enabled, by);
      case "override":
        return overrideMcpTool(
          input.name,
          input.tool,
          { ...(input.tier ? { tier: input.tier } : {}), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) },
          by,
        );
      case "remove":
        return deleteMcpServer(input.name, by);
      case "test":
        return testMcpTool(input.name, input.tool, input.args, by);
      case "review":
        return acknowledgeMcpDrift(input.name, by);
      case "master":
        return setMcpMasterSwitch(input.enabled, by);
    }
  })();

  return NextResponse.json(result.json, { status: result.status });
}
