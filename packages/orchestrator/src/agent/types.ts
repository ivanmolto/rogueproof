// Contracts between the agent loop and the pieces it drives. The policy (3.5)
// and the sandbox (3.4) implement these; the loop depends on nothing else.
import type { GatewayCall, Outcome, PolicyDecision, TimelineEvent } from "@rogueproof/shared";
import type { OtariClient, RunCounter, Role } from "../otari/index.js";

/** One tool set per turn. `report` calls are not part of this loop (task 5.x). */
export type Phase = "research" | "act";

export const LOCAL_TOOL_NAMES = ["read_file", "write_file", "run_command"] as const;
export type LocalToolName = (typeof LOCAL_TOOL_NAMES)[number];

/** A model tool call for a local tool, after its arguments parsed cleanly. */
export type LocalToolCall =
  | { tool: "read_file"; path: string }
  | { tool: "write_file"; path: string; content: string }
  | { tool: "run_command"; cmd: string };

export type PolicyVerdict = { decision: "allow" } | { decision: "deny"; rule: string; reason: string };

/** Deterministic tool policy. No model is involved in a verdict. */
export interface ToolPolicy {
  readonly name: string;
  evaluate(call: LocalToolCall): PolicyVerdict;
}

export interface ToolOutput {
  ok: boolean;
  output: string;
}

/** Local tool execution inside the sandbox container (`docker exec`). */
export interface Sandbox {
  readFile(path: string): Promise<ToolOutput>;
  writeFile(path: string, content: string): Promise<ToolOutput>;
  runCommand(cmd: string): Promise<ToolOutput>;
}

export interface Denial {
  call: LocalToolCall;
  rule: string;
  reason: string;
}

export interface JudgeFinding {
  rule: string;
  explanation: string;
  requestId?: string;
}

/**
 * Explains a denial that the policy has already made. It runs after the verdict
 * and cannot change it; returning undefined (judge unavailable) leaves the deny
 * in place with the policy's reason only. Shares the run's call counter.
 */
export type JudgeGate = (
  denial: Denial,
  /** `onCall` gets the judge's gateway call once it returned, so the loop can put Otari's guardrail verdict on it in the timeline. */
  ctx: { counter: RunCounter; onCall?: (call: GatewayCall) => void },
) => Promise<JudgeFinding | undefined>;

export interface RunAgentOptions {
  client: OtariClient;
  /** Directory holding MISSION.md (the per-run copy of scenarios/mission/). */
  mission: string;
  policy: ToolPolicy;
  sandbox: Sandbox;
  role: Extract<Role, "agent" | "capped" | "service" | "fallback">;
  /** Only valid with the service role; the client refuses it otherwise. */
  endUser?: string;
  /** Stored MCP server ids (the collector). Attached to act turns only. */
  mcpServerIds?: readonly string[];
  /** Selector to send as `model` on agent calls instead of the role's routing policy. */
  model?: string;
  judge?: JudgeGate;
  counter?: RunCounter;
  maxTokens?: number;
  temperature?: number;
  onEvent?: (e: TimelineEvent) => void;
  /** Every agent gateway call that was sent, as it returns (the same objects as `AgentRun.calls`). */
  onCall?: (c: GatewayCall) => void;
  /** Milliseconds clock, injectable for tests. */
  now?: () => number;
}

export interface AgentRun {
  /** `ok` when the model gave a final answer; otherwise the outcome that ended the run. */
  outcome: Outcome;
  finalAnswer: string | undefined;
  events: TimelineEvent[];
  /** Calls counted against the 40-call cap (agent + judge, retries included). */
  modelCalls: number;
  /** One entry per agent gateway call that was sent, in order. */
  calls: GatewayCall[];
  policyDecisions: PolicyDecision[];
  judgeFindings: JudgeFinding[];
  costUsd: number;
  /** Set when the run ended on a non-ok outcome. */
  error: { code: string | undefined; detail: string | undefined } | undefined;
}
