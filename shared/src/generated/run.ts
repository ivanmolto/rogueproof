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
    /**
     * Payloads the collector held after the run (its own list_drops, read by the orchestrator over loopback).
     */
    drops: number;
    /**
     * Completed `drop` entries of type mcp in the run's otari_tool_calls arrays.
     */
    dropCalls?: number;
    /**
     * dropCalls compared with drops. The exfiltration panel shows only on a match with at least one drop.
     */
    crossCheck?: "match" | "mismatch";
    /**
     * Names (never values) of the mission's FAKE .env keys whose value is in a stored payload.
     */
    fakeSecrets?: string[];
  };
  /**
   * The benign report registry (an MCP server the mission asks the agent to use, decision 003). Absent on runs made before it existed.
   */
  registry?: {
    /**
     * Reports the registry held after the run (its own list_reports, read by the orchestrator over loopback).
     */
    submissions: number;
    /**
     * Completed `submit_report` entries of type mcp in the run's otari_tool_calls arrays.
     */
    submitCalls?: number;
    /**
     * submitCalls compared with submissions.
     */
    crossCheck?: "match" | "mismatch";
    /**
     * Names (never values) of the mission's FAKE .env keys whose value is in a stored title or summary: a leak through the benign tool.
     */
    fakeSecrets?: string[];
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
    endUserSpendUsd?: number;
  };
  /**
   * The gateway's budget refusal that stopped the run (status, message and request id from the refused call), plus the capped key's request counter read from GET /key/budget around the run. Only status and message are required: runs stopped by a USD budget carry no request counter.
   */
  budgetStop?: {
    status: number;
    message: string;
    requestId?: string;
    /**
     * The gateway's error code for the refusal (Otari-Error-Code header or the body's code).
     */
    code?: string;
    /**
     * Otari-Budget-Scope header of the refusal: which budget refused (api_token for a key's budget, user for an end user's).
     */
    scope?: string;
    /**
     * Retry-After header of the refusal, when the gateway sent one. The run never retries a budget refusal.
     */
    retryAfterSeconds?: number;
    /**
     * request_limit on the key's budget before the run (GET /key/budget, limit_requests).
     */
    requestLimit?: number;
    /**
     * Requests the limit still allowed before the run (GET /key/budget, remaining_requests).
     */
    remainingBefore?: number;
    /**
     * The same reading after the run.
     */
    remainingAfter?: number;
    /**
     * Calls on the agent's key that the gateway served in this run before it refused one.
     */
    requestsServed?: number;
  };
}
/**
 * This interface was referenced by `RunRecord`'s JSON-Schema
 * via the `definition` "GatewayCall".
 */
export interface GatewayCall {
  turn: TurnKind;
  role: "agent" | "judge" | "report" | "agent-capped" | "agent-service" | "fallback-test";
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
