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
  /** From GET /end-users/{id}; undefined when the gateway did not report it. */
  endUserSpendUsd: number | undefined;
}

/** The model that actually served a call: the Otari-Model header, else what was requested. */
const served = (c: GatewayCall): string | undefined => c.otariHeaders?.["otari-model"] ?? c.model;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

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

  const record: RunRecord = {
    schemaVersion: 1,
    runId: f.runId,
    scenario: "agent-zero",
    mode: f.mode,
    profile: f.profile,
    control: false,
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
    collector: { drops: f.drops },
    usage,
  };

  if (f.agent.outcome === "budget_exceeded") {
    const refusal = f.records.findLast((r) => r.outcome === "budget_exceeded");
    const stop: NonNullable<RunRecord["budgetStop"]> = {
      status: refusal?.status ?? 0,
      message: f.agent.error?.detail ?? f.agent.error?.code ?? "budget exceeded",
    };
    if (refusal?.requestId !== undefined) stop.requestId = refusal.requestId;
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
