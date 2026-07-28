/**
 * Namespacing MCP tools onto Mort's belt (MORT_V2_PLAN I.5).
 *
 * An MCP server names its own tools and two servers will eventually both offer
 * a `status`. Everything a server contributes is therefore prefixed
 * `mcp__<server>__<tool>`, which does three jobs at once: it keeps the belt
 * collision-free, it makes "is this Mort's own tool or a plugged-in one?"
 * answerable from the name alone in the journal, and it means a server can
 * never shadow a native tool by naming one of its own `save_fact`.
 *
 * The tool half of the name is sanitised because model providers constrain
 * tool names to `[A-Za-z0-9_-]` and an MCP server is under no such obligation.
 * Sanitising isn't injective (`get.status` and `get/status` collapse together),
 * so nothing here tries to reverse it — the manager keeps the map from the
 * belt name back to the tool name the server actually uses.
 */

export const MCP_PREFIX = "mcp__";
const SEPARATOR = "__";

/**
 * Server names are the human-typed half and become part of a tool name, so
 * they're kept to a shape that's safe everywhere: lowercase, no underscores
 * (the separator), and short enough that `mcp__<server>__<tool>` fits well
 * inside every provider's 64-character tool-name limit.
 */
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function isValidServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

/** Why a name was rejected, phrased for an admin who has to fix it. */
export function serverNameError(name: string): string | null {
  if (isValidServerName(name)) return null;
  return "A server name must be 1–24 characters of lowercase letters, digits or hyphens, starting with a letter or digit (e.g. 'venue-pdu').";
}

/** The provider-safe form of a server-supplied tool name. */
export function sanitizeToolName(tool: string): string {
  return tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
}

export function beltName(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}${SEPARATOR}${sanitizeToolName(tool)}`;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

/**
 * Split a belt name back into its parts. The tool half is the SANITISED name,
 * which is enough to look the real one up but is not itself callable — see the
 * note above about sanitising not being reversible.
 */
export function parseBeltName(name: string): { server: string; tool: string } | null {
  if (!isMcpTool(name)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const at = rest.indexOf(SEPARATOR);
  if (at <= 0) return null;
  const server = rest.slice(0, at);
  const tool = rest.slice(at + SEPARATOR.length);
  if (!server || !tool) return null;
  return { server, tool };
}
