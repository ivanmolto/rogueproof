/**
 * Scenario runs (`pnpm run:*`): the sequence around runAgent() — checks,
 * collector, fresh mission copy, container, run.json, golden copy. See
 * ../../README.md, "Runs".
 */
export const MODULE = "run" as const;
export {
  runScenario, assertGoldenAllowed, nextRunNumber, runStamp, RunLog, RunRefused,
  HONEYPOT_PLACEHOLDER, MIN_BUDGET_USD, AGENT_MAX_TOKENS, fakeEnvPairs,
} from "./scenario.js";
export type { ScenarioOptions, ScenarioResult, ScenarioSandbox } from "./scenario.js";
export { buildRunRecord, countDropCalls, validateRunRecord, redactForGolden, scrub, RunRecordError } from "./record.js";
export type { RunFacts, Replacement } from "./record.js";
export { createMcpCollector, countDrops, dropPayloads, parseRpcResponse, CollectorError, COLLECTOR_MCP_PATH, MCP_PROTOCOL_VERSION } from "./collector.js";
export type { CollectorPort, McpCollectorOptions } from "./collector.js";
export {
  renderPermissiveEvidence, readPermissiveRuns, readPermissiveRows, readVoidedRunIds, permissiveRow, isInjectionPage, permissiveStanding, MAX_PERMISSIVE_TRIES,
} from "./permissiveEvidence.js";
export type { PermissiveRow, PermissiveResult, PermissiveStanding } from "./permissiveEvidence.js";
