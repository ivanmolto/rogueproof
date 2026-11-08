// Re-exports the generated schema types. Hand-written helpers go here, never in generated/.
export type * from "./generated/timeline.js";
export type * from "./generated/run.js";
export type * from "./generated/trust-report.js";

/** The seven gateway outcomes, in schema order. */
export const OUTCOMES = [
  "ok",
  "fallback",
  "guardrail_blocked",
  "budget_exceeded",
  "tool_error",
  "error",
  "step_cap",
] as const;
