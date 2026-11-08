/* eslint-disable */
/**
 * GENERATED FILE — do not edit by hand.
 * Source: shared/run.schema.json · regenerate with `pnpm gen:schemas`.
 * CI fails if this file drifts from the schema.
 */

/**
 * This interface was referenced by `RunRecord`'s JSON-Schema
 * via the `definition` "RunMode".
 */
export type RunMode = "safe" | "permissive" | "budget" | "control";
/**
 * This interface was referenced by `RunRecord`'s JSON-Schema
 * via the `definition` "ModelProfile".
 */
export type ModelProfile = "dev" | "rubric";
/**
 * Every gateway call (and the run) resolves to exactly one of these seven values.
 *
 * This interface was referenced by `RunRecord`'s JSON-Schema
 * via the `definition` "Outcome".
 */
export type Outcome =
  "ok" | "fallback" | "guardrail_blocked" | "budget_exceeded" | "tool_error" | "error" | "step_cap";
/**
 * One tool set per turn: Otari refuses web tools mixed with MCP or code execution.
 *
 * This interface was referenced by `RunRecord`'s JSON-Schema
 * via the `definition` "TurnKind".
 */
export type TurnKind = "research" | "act" | "report" | "judge";

/**
 * run.json: everything one scenario run produced. Golden copies are redacted before saving.
 */
export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  scenario: "agent-zero";
  mode: RunMode;
  profile: ModelProfile;
  /**
   * True only for the frontier control run (never rubric, never golden).
   */
  control: boolean;
  golden?: boolean;
  endUser: string;
  startedAt: string;
  finishedAt?: string;
  outcome: Outcome;
  modelCalls: number;
  models: {
    agent: string;
    judge?: string;
    report?: string;
    fallback?: string;
  };
  /**
   * One entry per gateway call, in order.
   */
  calls?: GatewayCall[];
  policyDecisions?: PolicyDecision[];
  judgeFindings?: {
    rule: string;
    explanation: string;
    requestId?: string;
  }[];
  collector?: {
    drops: number;
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    endUserSpendUsd?: number;
  };
  /**
   * Provisional until task 1.4 pins the real response shape from hosted otari.ai; do not treat as a contract.
   */
  budgetStop?: {
    status: number;
    message: string;
    requestId?: string;
  };
}
/**
 * This interface was referenced by `RunRecord`'s JSON-Schema
 * via the `definition` "GatewayCall".
 */
export interface GatewayCall {
  turn: TurnKind;
  role: "agent" | "judge" | "report" | "agent-capped" | "agent-service";
  model?: string;
  outcome: Outcome;
  requestId?: string;
  traceId?: string;
  /**
   * Provisional until task 1.4 pins the real response shape from hosted otari.ai; do not treat as a contract.
   */
  otariHeaders?: {
    [k: string]: string | undefined;
  };
  otariToolCalls: OtariToolCall[];
  costUsd?: number;
}
/**
 * One entry of a response's otari_tool_calls array (shape pinned in task 1.4). Provisional until task 1.4 pins the real response shape from hosted otari.ai; do not treat as a contract.
 *
 * This interface was referenced by `RunRecord`'s JSON-Schema
 * via the `definition` "OtariToolCall".
 */
export interface OtariToolCall {
  type: string;
}
/**
 * This interface was referenced by `RunRecord`'s JSON-Schema
 * via the `definition` "PolicyDecision".
 */
export interface PolicyDecision {
  tool: "read_file" | "write_file" | "run_command";
  decision: "allow" | "deny";
  rule?: string;
  argsSummary?: string;
}
