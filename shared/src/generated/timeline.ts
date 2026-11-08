/* eslint-disable */
/**
 * GENERATED FILE — do not edit by hand.
 * Source: shared/timeline.schema.json · regenerate with `pnpm gen:schemas`.
 * CI fails if this file drifts from the schema.
 */

/**
 * This interface was referenced by `Timeline`'s JSON-Schema
 * via the `definition` "TimelineEventType".
 */
export type TimelineEventType =
  | "search"
  | "fetch"
  | "read"
  | "tool"
  | "mcp"
  | "deny"
  | "guardrail"
  | "judge"
  | "post"
  | "budget"
  | "fallback"
  | "step_cap"
  | "done";

/**
 * Ordered events of one run, rebuilt by replay. fetch/search/mcp come only from otari_tool_calls; read/tool/deny/judge only from the orchestrator's own records.
 */
export interface Timeline {
  schemaVersion: 1;
  runId: string;
  events: TimelineEvent[];
}
/**
 * This interface was referenced by `Timeline`'s JSON-Schema
 * via the `definition` "TimelineEvent".
 */
export interface TimelineEvent {
  /**
   * Milliseconds since run start.
   */
  t: number;
  type: TimelineEventType;
  summary: string;
  /**
   * USD.
   */
  cost?: number;
  endUser?: string;
  traceId?: string;
  /**
   * Otari request id; required in practice for fetch/search/mcp events.
   */
  requestId?: string;
}
