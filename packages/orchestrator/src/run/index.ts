/**
 * Scenario runs (`pnpm run:*`): the sequence around runAgent() — checks,
 * collector, fresh mission copy, container, run.json, golden copy. See
 * ../../README.md, "Runs".
 */
export const MODULE = "run" as const;
export {
  runScenario, assertGoldenAllowed, nextRunNumber, runStamp, RunLog, RunRefused,
  HONEYPOT_PLACEHOLDER, MIN_BUDGET_USD, AGENT_MAX_TOKENS, fakeEnvPairs, assertControlAllowed, CONTROL_PROVIDER,
} from "./scenario.js";
export { trustReportColumn, trustReportColumns, trustColumnLabel, rubricModelsOnly, CONTROL_COLUMN_LABEL } from "./trustColumn.js";
export {
  generateTrustReport, assertReportRuns, localComputation, summarizeRun, reportInput, buildProgram, reportMessages, parseComputation, diffComputation,
  validateTrustReport, renderTrustReport, CLOSING_LINE, REPORT_MAX_TOKENS, RUBRIC_MODES,
} from "./trustReport.js";
export type { Computed, ComputedColumn, GenerateResult, GenerateOptions, ReportFailure, ReportInput, RunSummary, SummaryCall } from "./trustReport.js";
export type { ScenarioOptions, ScenarioResult, ScenarioSandbox } from "./scenario.js";
export { buildRunRecord, countDropCalls, countMcpCalls, REGISTRY_TOOL, validateRunRecord, redactForGolden, scrub, RunRecordError } from "./record.js";
export type { RunFacts, KeyRequests, Replacement } from "./record.js";
export { budgetResetReport, readBudgetPatchDoc, BUDGET_DOCS } from "./budgetReset.js";
export type { BudgetPatchDoc, ResetReport } from "./budgetReset.js";
export { COLLECTOR_SURFACE, REGISTRY_SURFACE, REGISTRY_MCP_PATH } from "./collector.js";
export type { McpSurface } from "./collector.js";
export { createMcpCollector, countDrops, dropPayloads, parseRpcResponse, CollectorError, COLLECTOR_MCP_PATH, MCP_PROTOCOL_VERSION } from "./collector.js";
export type { CollectorPort, McpCollectorOptions } from "./collector.js";
export {
  renderPermissiveEvidence, readPermissiveRuns, readPermissiveRows, readVoidedRunIds, permissiveRow, isInjectionPage, permissiveStanding, MAX_PERMISSIVE_TRIES,
} from "./permissiveEvidence.js";
export type { PermissiveRow, PermissiveResult, PermissiveStanding } from "./permissiveEvidence.js";
export { replayRun, replayDir, renderReplay, parseLogEvents, parseTimelineEvent, validateTimeline, ReplayError } from "./replay.js";
export type { ReplayResult, LoggedEvent } from "./replay.js";
export { liveRun, liveRunActive, liveProfile, parseLiveLine, isLiveMode, LIVE_MODES, LIVE_TIMEOUT_MS } from "./live.js";
export type { LiveMessage, LiveLine, LiveMode, LiveChild, LiveRunOptions } from "./live.js";
