/**
 * The MCP harness (MORT_V2_PLAN I.5) — external tools on Mort's belt, gated
 * and audited exactly like the native ones.
 *
 *   registry.ts  what is registered      (mort_mcp_servers, tiers, overrides)
 *   config.ts    how to reach it safely  (transport config, secrets as env refs)
 *   manager.ts   whether it's reachable  (connections, discovery, drift)
 *   naming.ts    what the model sees     (mcp__<server>__<tool>)
 *   belt.ts      what may happen         (policy, cards, journal)
 */

export { buildMcpAdminTools, buildMcpTools, MCP_RULES } from "./belt";
export { parseMcpConfig, redactConfig, TRANSPORTS, validateRegistration, type McpTransportKind } from "./config";
export {
  callMcpTool,
  closeMcpConnections,
  mcpStatus,
  mcpToolDefinition,
  mcpTools,
  refreshMcpServer,
  syncMcpConnections,
  type McpCallResult,
  type McpServerStatusRow,
  type McpToolInfo,
} from "./manager";
export { beltName, isMcpTool, isValidServerName, parseBeltName, serverNameError } from "./naming";
export {
  effectiveToolPolicy,
  getMcpServer,
  isMcpTier,
  listEnabledMcpServers,
  listMcpServers,
  MCP_TIERS,
  recordMcpFingerprints,
  removeMcpServer,
  setMcpServerEnabled,
  setMcpToolOverride,
  upsertMcpServer,
  type McpServerRow,
  type McpTier,
  type McpToolOverride,
} from "./registry";
