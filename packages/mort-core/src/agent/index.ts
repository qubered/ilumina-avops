/**
 * Mort's agent surface.
 *
 * The tools live in ./read-tools, ./memory-tools and ./kb-tools; which of them
 * a turn actually gets is the registry's decision, taken against the
 * channel/role policy (../tools/registry.ts, ../tools/policy.ts). The prompt
 * lives in ./prompt. The loop lives in ./run-turn. This module is the front
 * door those four are reached through — kept importable/server-side so a later
 * Slack bot phase can reuse it (brief §2 non-goals).
 */

export { getChatModel, getChatStack, systemPromptOptions } from "../model/chat";
export type { ActingUser } from "./pending-actions";
export type { ChatToolContext, PendingCard } from "./cards";
export type { KbSearchResult, WithProvenance } from "./read-tools";
export {
  agentTools,
  buildKbGetDocTool,
  buildKbSearchTool,
  currentStateTool,
  eventLogTool,
  kbSearchTool,
  mortLessonsTool,
  mortMemoryTool,
} from "./read-tools";
export { confirmPendingTool, listPendingTool, logEventTool, retireFactTool, saveFactTool } from "./memory-tools";
export {
  buildSystemPrompt,
  chatCanWriteKb,
  chatHasMcpTools,
  MAX_STEPS,
  SYSTEM_PROMPT,
  WRITE_RULES,
} from "./prompt";
export { prepareTurn, runTurn, runDreamTurn, runIngestTurn, runReflectionTurn } from "./run-turn";
export type {
  DreamTurnResult,
  IngestTurnResult,
  ReflectTurnResult,
  TurnContext,
  TurnEntry,
  TurnPlan,
  TurnResult,
} from "./run-turn";
// The reflection loop (P7): what Mort learnt, what it was learnt from, and the
// section of the prompt it becomes.
export { buildLessonsSection, capLessons, lessonsSection, MAX_LESSONS } from "./lessons-prompt";
export type { LessonDraft, ReflectionInput, ReflectTurnState } from "./reflection";
export type { IngestDeps, IngestFile, IngestUnderstanding } from "./ingest-tools";
// The belt itself, for callers assembling one outside a turn. Inside a turn,
// prepareTurn is the door — it settles the belt, the prompt, the step cap and
// the spend rail together, which is the point of there being a harness.
export { buildBelt, isToolAllowed, toolTier, TOOL_SPECS } from "../tools/registry";
export type { ToolContext } from "../tools/harness";
