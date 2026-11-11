// run.json: built from what the run actually produced (gateway calls with their
// otari_tool_calls and Otari-* headers, the orchestrator's policy decisions,
// judge findings, collector state, usage), validated against
// shared/run.schema.json before it is written. No model output decides a field
// here other than being recorded as data.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { GatewayCall, ModelProfile, RunMode, RunRecord } from "@rogueproof/shared";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AgentRun } from "../agent/index.js";
import { redact, type GatewayRecord } from "../otari/index.js";

const require = createRequire(import.meta.url);
const schema = JSON.parse(readFileSync(require.resolve("@rogueproof/shared/run.schema.json"), "utf8")) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
// RFC 3339 as `Date#toISOString` writes it; enough for a field we only ever write that way.
ajv.addFormat("date-time", (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)));
const validate = ajv.compile(schema);

/** Schema violations as `path message` lines; empty when `value` is a valid run.json. */
export function validateRunRecord(value: unknown): string[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}

export class RunRecordError extends Error {
  override readonly name = "RunRecordError";
  constructor(readonly violations: readonly string[]) {
    super(`run.json does not match shared/run.schema.json:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
  }
}

export interface RunFacts {
  runId: string;
  mode: RunMode;
  profile: ModelProfile;
  golden: boolean;
  endUser: string;
  startedAt: Date;
  finishedAt: Date;
  agent: AgentRun;
  /** Agent and judge gateway calls in the order they returned. */
  calls: readonly GatewayCall[];
  /** The client's redacted records; token counts and the budget refusal's status come from here. */
  records: readonly GatewayRecord[];
  drops: number;
  /** Names of the mission's FAKE .env keys whose value is in a stored payload; undefined when the payloads were not read. */
  fakeSecrets?: readonly string[];
  /** The report registry's own state after the run; undefined when the run had no registry. */
  registry?: { submissions: number; fakeSecrets?: readonly string[] };
  /** From GET /end-users/{id}; undefined when the gateway did not report it. */
  endUserSpendUsd: number | undefined;
  /** The agent key's request counter (GET /key/budget) before and after the run; Budget-limited mode reads it. */
  keyRequests?: KeyRequests;
}

/** A key's request-limited budget as GET /key/budget reports it. Every field is the gateway's own number. */
export interface KeyRequests {
  limit?: number;
  remainingBefore?: number;
  remainingAfter?: number;
}

const SERVED = new Set<GatewayCall["outcome"]>(["ok", "fallback", "tool_error"]);
const wholeNumber = (v: number | undefined): v is number => v !== undefined && Number.isInteger(v) && v >= 0;

/** The model that actually served a call: the Otari-Model header, else what was requested. */
const served = (c: GatewayCall): string | undefined => c.otariHeaders?.["otari-model"] ?? c.model;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/**
 * Completed `drop` calls on an MCP server, counted from the gateway's own
 * `otari_tool_calls` entries. A model saying it dropped something is not one.
 */
export function countDropCalls(calls: readonly GatewayCall[]): number {
  return countMcpCalls(calls, "drop");
}

/** Tool the benign report registry offers the agent (scenarios/registry, decision 003). */
export const REGISTRY_TOOL = "submit_report";

/** Completed MCP calls of one tool name in the run's `otari_tool_calls` arrays. External input: never throws. */
export function countMcpCalls(calls: readonly GatewayCall[], name: string): number {
  let n = 0;
  for (const c of calls) {
    for (const t of c.otariToolCalls as readonly unknown[]) {
      if (isObj(t) && t["type"] === "mcp" && t["name"] === name && t["status"] === "completed") n++;
    }
  }
  return n;
}

export function buildRunRecord(f: RunFacts): RunRecord {
  const agentCalls = f.calls.filter((c) => c.turn !== "judge");
  const judgeCalls = f.calls.filter((c) => c.turn === "judge");
  const models: RunRecord["models"] = { agent: (agentCalls.map(served).find((m) => m !== undefined) ?? f.agent.calls[0]?.model) ?? "unknown" };
  const judge = judgeCalls.map(served).find((m) => m !== undefined);
  if (judge !== undefined) models.judge = judge;
  const rescued = f.calls.find((c) => c.outcome === "fallback" || c.otariHeaders?.["otari-fallback"] === "true");
  const fallback = rescued && served(rescued);
  if (fallback !== undefined) models.fallback = fallback;

  let promptTokens = 0;
  let completionTokens = 0;
  for (const r of f.records) {
    const usage = isObj(r.response) ? r.response["usage"] : undefined;
    if (!isObj(usage)) continue;
    promptTokens += count(usage["prompt_tokens"]);
    completionTokens += count(usage["completion_tokens"]);
  }
  const usage: NonNullable<RunRecord["usage"]> = {
    promptTokens,
    completionTokens,
    costUsd: f.calls.reduce((s, c) => s + (c.costUsd ?? 0), 0),
  };
  if (f.endUserSpendUsd !== undefined) usage.endUserSpendUsd = f.endUserSpendUsd;

  // The gateway's evidence (otari_tool_calls) against the collector's own state (list_drops).
  const dropCalls = countDropCalls(f.calls);
  const record: RunRecord = {
    schemaVersion: 1,
    runId: f.runId,
    scenario: "agent-zero",
    mode: f.mode,
    profile: f.profile,
    control: f.mode === "control",
    golden: f.golden,
    endUser: f.endUser,
    startedAt: f.startedAt.toISOString(),
    finishedAt: f.finishedAt.toISOString(),
    outcome: f.agent.outcome,
    modelCalls: f.agent.modelCalls,
    models,
    calls: [...f.calls],
    policyDecisions: f.agent.policyDecisions,
    judgeFindings: f.agent.judgeFindings,
    collector: { drops: f.drops, dropCalls, crossCheck: dropCalls === f.drops ? "match" : "mismatch" },
    usage,
  };
  if (f.fakeSecrets !== undefined) record.collector!.fakeSecrets = [...f.fakeSecrets];
  if (f.registry !== undefined) {
    // Same cross-check as the collector's: the gateway's entries against the server's own list.
    const submitCalls = countMcpCalls(f.calls, REGISTRY_TOOL);
    record.registry = { submissions: f.registry.submissions, submitCalls, crossCheck: submitCalls === f.registry.submissions ? "match" : "mismatch" };
    if (f.registry.fakeSecrets !== undefined) record.registry.fakeSecrets = [...f.registry.fakeSecrets];
  }

  if (f.agent.outcome === "budget_exceeded") {
    const refusal = f.records.findLast((r) => r.outcome === "budget_exceeded");
    const stop: NonNullable<RunRecord["budgetStop"]> = {
      status: refusal?.status ?? 0,
      message: f.agent.error?.detail ?? f.agent.error?.code ?? "budget exceeded",
    };
    if (refusal?.requestId !== undefined) stop.requestId = refusal.requestId;
    if (f.agent.error?.code !== undefined) stop.code = f.agent.error.code;
    const scope = refusal?.headers["otari-budget-scope"];
    if (scope !== undefined) stop.scope = scope;
    const retryAfter = Number(refusal?.headers["retry-after"]);
    if (refusal?.headers["retry-after"] !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0) stop.retryAfterSeconds = retryAfter;
    if (wholeNumber(f.keyRequests?.limit)) stop.requestLimit = f.keyRequests.limit;
    if (wholeNumber(f.keyRequests?.remainingBefore)) stop.remainingBefore = f.keyRequests.remainingBefore;
    if (wholeNumber(f.keyRequests?.remainingAfter)) stop.remainingAfter = f.keyRequests.remainingAfter;
    // Calls on the agent's key that got a response; judge calls are on another key and another budget.
    stop.requestsServed = agentCalls.filter((c) => SERVED.has(c.outcome)).length;
    record.budgetStop = stop;
  }
  // Keys cannot be in here (headers are picked and redacted by the client), but a
  // model or a page can echo anything into a summary or a tool-call entry.
  return redact(record);
}

/** Literal strings to replace in a golden copy: secrets, and hosts we do not publish. */
export type Replacement = readonly [find: string, replaceWith: string];

/** Applies the key-pattern redaction, then the literal replacements, to a string. */
export function scrub(text: string, replacements: readonly Replacement[]): string {
  let out = redact(text);
  for (const [find, to] of replacements) if (find !== "") out = out.split(find).join(to);
  return out;
}

/** The redacted copy of a run.json that goes under runs/golden/. */
export function redactForGolden(record: RunRecord, replacements: readonly Replacement[]): RunRecord {
  return JSON.parse(scrub(JSON.stringify({ ...record, golden: true }), replacements)) as RunRecord;
}
