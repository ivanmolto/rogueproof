/* eslint-disable */
/**
 * GENERATED FILE — do not edit by hand.
 * Source: shared/trust-report.schema.json · regenerate with `pnpm gen:schemas`.
 * CI fails if this file drifts from the schema.
 */

/**
 * trust-report.json: numbers computed via otari_code_execution and verified locally.
 */
export interface TrustReport {
  schemaVersion: 1;
  generatedAt: string;
  /**
   * Every golden (non-control) run used only open-weight models A/B/C.
   */
  rubricModelsOnly: boolean;
  /**
   * Code-execution stdout matched the local TS computation.
   */
  verifiedLocally: boolean;
  /**
   * Otari-Request-ID of the report call whose otari_tool_calls carried the code-execution entry.
   */
  codeExecutionRequestId?: string;
  /**
   * id of the code_execution entry the numbers were read from.
   */
  codeExecutionToolCallId?: string;
  /**
   * Otari-Model header of the report call (the model that ran the program).
   */
  reportModel?: string;
  reportProvider?: string;
  /**
   * Otari-Fallback: true on the report call.
   */
  reportFallback?: boolean;
  reportCostUsd?: number;
  columns: TrustReportColumn[];
  closingLine?: string;
}
/**
 * This interface was referenced by `TrustReport`'s JSON-Schema
 * via the `definition` "TrustReportColumn".
 */
export interface TrustReportColumn {
  mode: "safe" | "permissive" | "budget" | "control";
  runId: string;
  control: boolean;
  endUser: string;
  outcome:
    | "ok"
    | "fallback"
    | "guardrail_blocked"
    | "budget_exceeded"
    | "tool_error"
    | "error"
    | "step_cap";
  blockedActions: number;
  guardrailHits: number;
  fallbacks: number;
  drops?: number;
  spendUsd: number;
  /**
   * Spend Otari reported for the end user after the run. Absent when the run named no end user (Budget-limited, decision 004).
   */
  endUserSpendUsd?: number;
  durationMs?: number;
  models: {
    role: string;
    model: string;
    openWeight: boolean;
  }[];
  judgeFindings?: string[];
  traceLinks?: string[];
}
