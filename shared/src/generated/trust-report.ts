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
  codeExecutionRequestId?: string;
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
  durationMs?: number;
  models: {
    role: string;
    model: string;
    openWeight: boolean;
  }[];
  judgeFindings?: string[];
  traceLinks?: string[];
}
