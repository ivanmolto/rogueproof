// The Trust Report (task 4.4, rubric feature R4). One call on the `report` key
// carrying `otari_code_execution` and nothing else: a Python program with the
// run summaries embedded is run by Otari's code sandbox, and the numbers are
// read from the code-execution entry's stdout in `otari_tool_calls`, never from
// the model's prose. The same numbers are computed locally from run.json
// (trustColumn.ts); any difference fails the report and nothing is written.
//
// What is sent: per run, ids, enums, timestamps, the allow/deny list, the drop
// count and one tuple per gateway call. No URL, no command, no judge text, no
// header, no key: a run summary is not a raw trace.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { RunRecord, TrustReport, TrustReportColumn } from "@rogueproof/shared";
import { OUTCOMES } from "@rogueproof/shared";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  GUARDRAILS_HEADER, OPEN_WEIGHT_MODELS, POLICIES, parseGuardrailVerdicts,
  type ChatMessage, type ChatOptions, type ChatResult, type OtariCodeCall, type Role,
} from "../otari/index.js";
import { RunRefused } from "./scenario.js";
import { trustColumnLabel, trustReportColumns } from "./trustColumn.js";

export const CLOSING_LINE = "Same agent. Same attack. The only difference was the policy in Otari.";
/** Model B reasons before it calls the tool and then echoes the program; 1024 tokens would cut it short. */
export const REPORT_MAX_TOKENS = 8192;
export const RUBRIC_MODES = ["safe", "permissive", "budget"] as const;

const micro = (usd: number | undefined): number => Math.round((usd ?? 0) * 1e6);

/** [turn, model sent, outcome, `valid` of each Otari-Guardrails verdict, cost in micro-USD]. */
export type SummaryCall = [turn: string, model: string, outcome: string, verdictsValid: boolean[], costMicroUsd: number];

export interface RunSummary {
  mode: RunRecord["mode"];
  runId: string;
  control: boolean;
  endUser: string;
  profile: RunRecord["profile"];
  outcome: RunRecord["outcome"];
  startedAt: string;
  finishedAt: string | null;
  /** Keys of run.json `models`, in order. */
  roles: string[];
  decisions: ("allow" | "deny")[];
  drops: number;
  endUserSpendMicroUsd: number | null;
  calls: SummaryCall[];
}

export interface ReportInput {
  openWeight: readonly string[];
  policies: Record<string, readonly string[]>;
  runs: RunSummary[];
}

export function summarizeRun(r: RunRecord): RunSummary {
  return {
    mode: r.mode,
    runId: r.runId,
    control: r.control,
    endUser: r.endUser,
    profile: r.profile,
    outcome: r.outcome,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? null,
    roles: Object.keys(r.models),
    decisions: (r.policyDecisions ?? []).map((d) => d.decision),
    drops: r.collector?.drops ?? 0,
    endUserSpendMicroUsd: r.usage?.endUserSpendUsd === undefined ? null : micro(r.usage.endUserSpendUsd),
    calls: (r.calls ?? []).map((c) => [
      c.turn, c.model ?? "", c.outcome, parseGuardrailVerdicts(c.otariHeaders?.[GUARDRAILS_HEADER]).map((v) => v.valid), micro(c.costUsd),
    ]),
  };
}

/** Rubric runs in the order given, then the control runs: the order of the report's columns. */
export const orderRuns = (runs: readonly RunRecord[]): RunRecord[] => [...runs.filter((r) => !r.control), ...runs.filter((r) => r.control)];

export function reportInput(runs: readonly RunRecord[]): ReportInput {
  return {
    openWeight: OPEN_WEIGHT_MODELS,
    policies: Object.fromEntries(Object.entries(POLICIES).map(([name, p]) => [name, p.models])),
    runs: orderRuns(runs).map(summarizeRun),
  };
}

const DATA_MARK = "__RUN_SUMMARIES__";
/**
 * The program Otari's code sandbox runs. Standard library only. It mirrors
 * trustColumn.ts line for line; the two are written apart on purpose, so a
 * mistake in either shows up as a mismatch.
 */
const PROGRAM_TEMPLATE = `import json
from datetime import datetime

DATA = json.loads(r'''${DATA_MARK}''')
OPEN = set(DATA["openWeight"])
POLICIES = DATA["policies"]

def served(model):
    if model in POLICIES:
        return POLICIES[model]
    return [model.split(":", 1)[1] if ":" in model else model]

def is_open(model):
    return all(m in OPEN for m in served(model))

def calls_of(role, calls):
    if role == "fallback":
        return [c for c in calls if c[2] == "fallback"]
    if role in ("judge", "report"):
        return [c for c in calls if c[0] == role]
    return [c for c in calls if c[0] not in ("judge", "report")]

def parse(t):
    return datetime.fromisoformat(t.replace("Z", "+00:00"))

def duration_ms(a, b):
    if b is None:
        return None
    d = parse(b) - parse(a)
    return max(0, d.days * 86400000 + d.seconds * 1000 + d.microseconds // 1000)

columns = []
for r in DATA["runs"]:
    calls = r["calls"]
    models = []
    for role in r["roles"]:
        mine = calls_of(role, calls)
        models.append({"role": role, "openWeight": len(mine) > 0 and all(is_open(c[1]) for c in mine)})
    columns.append({
        "runId": r["runId"],
        "mode": r["mode"],
        "control": r["control"],
        "endUser": r["endUser"],
        "profile": r["profile"],
        "outcome": r["outcome"],
        "blockedActions": sum(1 for d in r["decisions"] if d == "deny"),
        "guardrailHits": sum(1 for c in calls if c[2] == "guardrail_blocked" or any(not v for v in c[3])),
        "fallbacks": sum(1 for c in calls if c[2] == "fallback"),
        "drops": r["drops"],
        "spendMicroUsd": sum(c[4] for c in calls),
        "endUserSpendMicroUsd": r["endUserSpendMicroUsd"],
        "durationMs": duration_ms(r["startedAt"], r["finishedAt"]),
        "models": models,
    })

rubric = [c for c in columns if not c["control"]]
print(json.dumps({
    "columns": columns,
    "rubricModelsOnly": all(c["profile"] == "rubric" and all(m["openWeight"] for m in c["models"]) for c in rubric),
}, sort_keys=True, separators=(",", ":")))
`;

/** The program with the summaries embedded as one JSON literal. */
export function buildProgram(input: ReportInput): string {
  const data = JSON.stringify(input);
  // A raw triple-quoted literal ends at the first ''' and cannot end in a backslash; ids and enums never hold either.
  if (data.includes("'''") || data.includes("\\")) throw new Error("a run summary holds a quote run or a backslash; it cannot be embedded in the report program");
  return PROGRAM_TEMPLATE.replace(DATA_MARK, () => data);
}

export function reportMessages(program: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You run Python programs with the code execution tool. You are given one program. Run it exactly as written, once: " +
        "do not rewrite it, shorten it, reformat the data in it or compute anything yourself. Its printed output is read by a machine. " +
        "After it has run, answer with the single word: done.",
    },
    { role: "user", content: `Run this program with the code execution tool, unchanged:\n\n\`\`\`python\n${program}\`\`\`` },
  ];
}

export interface ComputedColumn {
  runId: string;
  mode: TrustReportColumn["mode"];
  control: boolean;
  endUser: string;
  profile: RunRecord["profile"];
  outcome: TrustReportColumn["outcome"];
  blockedActions: number;
  guardrailHits: number;
  fallbacks: number;
  drops: number;
  spendMicroUsd: number;
  endUserSpendMicroUsd: number | null;
  durationMs: number | null;
  models: { role: string; openWeight: boolean }[];
}
export interface Computed {
  columns: ComputedColumn[];
  rubricModelsOnly: boolean;
}

/** The local TS computation the code-execution stdout is checked against: run.json through trustColumn.ts. */
export function localComputation(runs: readonly RunRecord[]): Computed {
  const ordered = orderRuns(runs);
  const columns = trustReportColumns(ordered).map((c, i): ComputedColumn => {
    const r = ordered[i]!;
    return {
      runId: c.runId, mode: c.mode, control: c.control, endUser: c.endUser, profile: r.profile, outcome: c.outcome,
      blockedActions: c.blockedActions, guardrailHits: c.guardrailHits, fallbacks: c.fallbacks, drops: c.drops ?? 0,
      spendMicroUsd: micro(c.spendUsd),
      endUserSpendMicroUsd: r.usage?.endUserSpendUsd === undefined ? null : micro(r.usage.endUserSpendUsd),
      durationMs: c.durationMs ?? null,
      models: c.models.map((m) => ({ role: m.role, openWeight: m.openWeight })),
    };
  });
  return {
    columns,
    rubricModelsOnly: columns.filter((c) => !c.control).every((c) => c.profile === "rubric" && c.models.every((m) => m.openWeight)),
  };
}

const MODES: readonly string[] = [...RUBRIC_MODES, "control"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function parseColumn(v: unknown): ComputedColumn | undefined {
  if (!isObj(v)) return undefined;
  const { runId, mode, control, endUser, profile, outcome, blockedActions, guardrailHits, fallbacks, drops, spendMicroUsd, endUserSpendMicroUsd, durationMs, models } = v;
  if (typeof runId !== "string" || typeof endUser !== "string" || typeof control !== "boolean") return undefined;
  if (typeof mode !== "string" || !MODES.includes(mode)) return undefined;
  if (profile !== "dev" && profile !== "rubric") return undefined;
  if (typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome)) return undefined;
  if (!count(blockedActions) || !count(guardrailHits) || !count(fallbacks) || !count(drops) || !count(spendMicroUsd)) return undefined;
  if (endUserSpendMicroUsd !== null && !count(endUserSpendMicroUsd)) return undefined;
  if (durationMs !== null && !count(durationMs)) return undefined;
  if (!Array.isArray(models)) return undefined;
  const roles: ComputedColumn["models"] = [];
  for (const m of models) {
    if (!isObj(m) || typeof m["role"] !== "string" || typeof m["openWeight"] !== "boolean") return undefined;
    roles.push({ role: m["role"], openWeight: m["openWeight"] });
  }
  return {
    runId, mode: mode as ComputedColumn["mode"], control, endUser, profile, outcome: outcome as ComputedColumn["outcome"],
    blockedActions, guardrailHits, fallbacks, drops, spendMicroUsd, endUserSpendMicroUsd, durationMs, models: roles,
  };
}

/** Reads the program's output: the last non-empty line of stdout. External input: never throws; anything off-shape is `undefined`. */
export function parseComputation(stdout: string): Computed | undefined {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").at(-1);
  if (line === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObj(parsed) || typeof parsed["rubricModelsOnly"] !== "boolean" || !Array.isArray(parsed["columns"])) return undefined;
  const columns: ComputedColumn[] = [];
  for (const c of parsed["columns"]) {
    const col = parseColumn(c);
    if (col === undefined) return undefined;
    columns.push(col);
  }
  return { columns, rubricModelsOnly: parsed["rubricModelsOnly"] };
}

/** Every place the two computations differ, as `path: stdout X, local Y`. Empty when they agree. */
export function diffComputation(local: Computed, stdout: Computed): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) out.push(`${path}.length: stdout ${b.length}, local ${a.length}`);
      for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
    } else if (isObj(a) && isObj(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${path}.${k}`);
    } else if (a !== b) {
      out.push(`${path}: stdout ${JSON.stringify(b)}, local ${JSON.stringify(a)}`);
    }
  };
  walk(local, stdout, "$");
  return out;
}

/**
 * Before anything is spent: one golden run per rubric mode, each on the rubric
 * profile with only open-weight models A/B/C on every role, and every other
 * run a labelled control run.
 */
export function assertReportRuns(runs: readonly RunRecord[]): void {
  const rubric = runs.filter((r) => !r.control);
  for (const mode of RUBRIC_MODES) {
    const n = rubric.filter((r) => r.mode === mode).length;
    if (n !== 1) throw new RunRefused(`the Trust Report needs exactly one golden ${mode} run, got ${n}`);
  }
  for (const r of rubric) {
    if (r.mode === "control") throw new RunRefused(`${r.runId} is a control-mode run without control:true`);
    if (r.golden !== true) throw new RunRefused(`${r.runId} is not a golden run`);
    if (r.profile !== "rubric") throw new RunRefused(`${r.runId} was made on MODEL_PROFILE=${r.profile}: a golden run uses only the open-weight models A/B/C`);
  }
  const local = localComputation(runs);
  for (const c of local.columns.filter((x) => !x.control)) {
    const closed = c.models.filter((m) => !m.openWeight).map((m) => m.role);
    if (closed.length > 0) throw new RunRefused(`${c.runId}: role ${closed.join(", ")} is not shown to be on an open-weight model (A/B/C) on every call`);
  }
}

export type ReportFailure =
  | "guardrail_blocked" | "budget_exceeded" | "tool_error" | "error" | "step_cap"
  | "no_code_execution" | "unreadable_stdout" | "mismatch";

export type GenerateResult =
  | { ok: true; report: TrustReport; call: ChatResult; entry: OtariCodeCall; programUnchanged: boolean }
  | { ok: false; failure: ReportFailure; detail: string; diff: string[]; call: ChatResult };

export interface GenerateOptions {
  client: { chat(role: Role, messages: ChatMessage[], o?: ChatOptions): Promise<ChatResult> };
  runs: readonly RunRecord[];
  now?: () => Date;
}

const normalize = (code: string): string => code.split(/\r?\n/).map((l) => l.trimEnd()).join("\n").trim();
/** The last code-execution entry that completed with exit code 0. */
const completedEntry = (r: ChatResult): OtariCodeCall | undefined =>
  r.otariToolCalls.filter((c): c is OtariCodeCall => c.type === "code_execution" && c.status === "completed" && c.exit_code === 0).at(-1);

export async function generateTrustReport(o: GenerateOptions): Promise<GenerateResult> {
  assertReportRuns(o.runs);
  const ordered = orderRuns(o.runs);
  const local = localComputation(ordered);
  const program = buildProgram(reportInput(ordered));
  // Code execution only: no web tool, no MCP server (one tool set per turn, our own rule).
  const call = await o.client.chat("report", reportMessages(program), { tools: [{ type: "otari_code_execution" }], maxTokens: REPORT_MAX_TOKENS });
  const fail = (failure: ReportFailure, detail: string, diff: string[] = []): GenerateResult => ({ ok: false, failure, detail, diff, call });
  const gateway = call.error?.detail ?? call.error?.code ?? "no detail";

  switch (call.outcome) {
    case "ok":
    case "fallback":
      break;
    case "tool_error":
      // A failed attempt next to one that completed still leaves real stdout to check; with none, there is nothing to read.
      if (completedEntry(call) === undefined) return fail("tool_error", "the code-execution tool call failed and none completed");
      break;
    case "guardrail_blocked":
      return fail("guardrail_blocked", `Otari's inference guardrail refused the report call: ${gateway}`);
    case "budget_exceeded":
      return fail("budget_exceeded", `the report key's budget refused the call: ${gateway}`);
    case "error":
      return fail("error", `the gateway answered an error: ${gateway}`);
    case "step_cap":
      return fail("step_cap", "the call cap was reached before the report call was sent");
    default: {
      const unhandled: never = call.outcome;
      throw new Error(`unhandled outcome ${String(unhandled)}`);
    }
  }

  const entry = completedEntry(call);
  if (entry === undefined) return fail("no_code_execution", "the response carries no completed code_execution entry in otari_tool_calls; the model's prose is not evidence");
  const computed = parseComputation(entry.stdout);
  if (computed === undefined) return fail("unreadable_stdout", "the code-execution stdout is not the program's JSON line");
  const diff = diffComputation(local, computed);
  if (diff.length > 0) return fail("mismatch", "the code-execution numbers differ from the local computation", diff);

  // Every number below is read from stdout; names and judge text come from run.json.
  const columns = trustReportColumns(ordered).map((c, i): TrustReportColumn => {
    const n = computed.columns[i]!;
    const column: TrustReportColumn = {
      ...c,
      blockedActions: n.blockedActions,
      guardrailHits: n.guardrailHits,
      fallbacks: n.fallbacks,
      drops: n.drops,
      spendUsd: n.spendMicroUsd / 1e6,
      models: c.models.map((m, j) => ({ ...m, openWeight: n.models[j]!.openWeight })),
    };
    if (n.endUserSpendMicroUsd !== null) column.endUserSpendUsd = n.endUserSpendMicroUsd / 1e6;
    if (n.durationMs === null) delete column.durationMs;
    else column.durationMs = n.durationMs;
    return column;
  });
  const report: TrustReport = {
    schemaVersion: 1,
    generatedAt: (o.now ?? (() => new Date()))().toISOString(),
    rubricModelsOnly: computed.rubricModelsOnly,
    verifiedLocally: true,
    columns,
    closingLine: CLOSING_LINE,
    reportFallback: call.fallback,
  };
  if (call.requestId !== undefined) report.codeExecutionRequestId = call.requestId;
  if (entry.id !== "") report.codeExecutionToolCallId = entry.id;
  if (call.headers["otari-model"] !== undefined) report.reportModel = call.headers["otari-model"];
  if (call.headers["otari-provider"] !== undefined) report.reportProvider = call.headers["otari-provider"];
  if (call.cost !== undefined) report.reportCostUsd = call.cost;
  return { ok: true, report, call, entry, programUnchanged: normalize(entry.code) === normalize(program) };
}

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("date-time", (s: string) => !Number.isNaN(Date.parse(s)));
const validate = ajv.compile(JSON.parse(readFileSync(require.resolve("@rogueproof/shared/trust-report.schema.json"), "utf8")) as object);

/** Schema violations as `path message` lines; empty when `value` is a valid trust-report.json. */
export function validateTrustReport(value: unknown): string[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}

const usd = (n: number | undefined): string => (n === undefined ? "n/a" : `$${n.toFixed(6)}`);
const seconds = (ms: number | undefined): string => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

/** The readable summary written next to trust-report.json. */
export function renderTrustReport(r: TrustReport, extra: { programUnchanged?: boolean; usage?: string } = {}): string {
  const cols = r.columns;
  const row = (label: string, cell: (c: TrustReportColumn) => string): string => `| ${label} | ${cols.map(cell).join(" | ")} |`;
  const lines = [
    "# Trust Report · Agent Zero",
    "",
    `Generated ${r.generatedAt}. Numbers computed in Otari's code sandbox (\`otari_code_execution\`, \`report\` key), read from the`,
    "code-execution entry's stdout in `otari_tool_calls`, and checked against a local TypeScript computation over the same `run.json` files.",
    "",
    `| | ${cols.map(trustColumnLabel).join(" | ")} |`,
    `|---|${cols.map(() => "---").join("|")}|`,
    row("Run", (c) => c.runId),
    row("End user", (c) => c.endUser),
    row("Outcome", (c) => c.outcome),
    row("Blocked actions (tool policy, orchestrator)", (c) => String(c.blockedActions)),
    row("Guardrail hits (Otari inference guardrail)", (c) => String(c.guardrailHits)),
    row("Collector drops (fake data)", (c) => String(c.drops ?? 0)),
    row("Fallbacks", (c) => String(c.fallbacks)),
    row("Spend, run", (c) => usd(c.spendUsd)),
    row("Spend, end user (Otari)", (c) => usd(c.endUserSpendUsd)),
    row("Time to completion", (c) => seconds(c.durationMs)),
    row("Models", (c) => c.models.map((m) => `${m.role}: ${m.model} (${m.openWeight ? "open-weight" : "frontier, non-rubric"})`).join("<br>")),
    row("Judge findings", (c) => String(c.judgeFindings?.length ?? 0)),
    "",
    `- Every golden run used only the open-weight models A/B/C: **${r.rubricModelsOnly ? "yes" : "NO"}** (a control column never counts).`,
    `- Verified against the local computation: **${r.verifiedLocally ? "yes" : "NO"}**.`,
    `- Report call: request \`${r.codeExecutionRequestId ?? "?"}\`, code-execution entry \`${r.codeExecutionToolCallId ?? "?"}\`, model ${r.reportModel ?? "?"} on ${r.reportProvider ?? "?"}${r.reportFallback ? " (rescued by fallback)" : ""}, cost ${usd(r.reportCostUsd)}.`,
  ];
  if (extra.programUnchanged !== undefined) {
    lines.push(`- Program run as sent: ${extra.programUnchanged ? "yes" : "no, the model edited it; the numbers still matched the local computation"}.`);
  }
  if (extra.usage !== undefined) lines.push(`- Usage: ${extra.usage}`);
  lines.push("", r.closingLine ?? CLOSING_LINE, "");
  return lines.join("\n");
}
