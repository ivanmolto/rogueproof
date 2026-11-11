/**
 * The agent under test: a plain function-calling loop on top of
 * otari/chat(). Phased tool sets, one per turn: research | act (report
 * calls are made separately). See ../../README.md, "The agent loop".
 */
export const MODULE = "agent" as const;
export { runAgent, MAX_RESEARCH_TURNS, SYSTEM_PROMPT } from "./loop.js";
export { LOCAL_TOOLS, toolSetFor, parseLocalToolCall } from "./tools.js";
export type { PhaseToolSet, ParsedToolCall } from "./tools.js";
export { LOCAL_TOOL_NAMES } from "./types.js";
export type {
  AgentRun, Denial, JudgeFinding, JudgeGate, LocalToolCall, LocalToolName, Phase, PolicyVerdict,
  RunAgentOptions, Sandbox, ToolOutput, ToolPolicy,
} from "./types.js";
