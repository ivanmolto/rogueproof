// One Trust Report column per saved run, computed from run.json only (task 4.1b
// needs the control run's column; task 4.4 verifies the code-execution numbers
// against this local computation). No model output decides a number here: blocks
// are the orchestrator's policy decisions, guardrail hits are Otari's refusals
// and Otari-Guardrails verdicts, drops are the collector's own count.
import type { GatewayCall, RunRecord, TrustReportColumn } from "@rogueproof/shared";
import { GUARDRAILS_HEADER, isOpenWeight, parseGuardrailVerdicts } from "../otari/index.js";

export const CONTROL_COLUMN_LABEL = "Control (frontier model, not a rubric run)";
const MODE_LABEL: Record<TrustReportColumn["mode"], string> = {
  safe: "Safe",
  permissive: "Permissive",
  budget: "Budget-limited",
  control: CONTROL_COLUMN_LABEL,
};

/** Heading of a column. A control column is always labelled as one, whatever its mode says. */
export const trustColumnLabel = (c: Pick<TrustReportColumn, "mode" | "control">): string => (c.control ? CONTROL_COLUMN_LABEL : MODE_LABEL[c.mode]);

const guardrailHit = (c: GatewayCall): boolean =>
  c.outcome === "guardrail_blocked" || parseGuardrailVerdicts(c.otariHeaders?.[GUARDRAILS_HEADER]).some((v) => !v.valid);

export function trustReportColumn(r: RunRecord): TrustReportColumn {
  const calls = r.calls ?? [];
  // Open weight is decided by what was requested (a routing policy or a selector), per role: every call must qualify.
  const models: TrustReportColumn["models"] = [];
  for (const [role, model] of Object.entries(r.models) as [keyof RunRecord["models"], string][]) {
    const turn = (c: GatewayCall) => (role === "judge" || role === "report" ? c.turn === role : c.turn !== "judge" && c.turn !== "report");
    const mine = role === "fallback" ? calls.filter((c) => c.outcome === "fallback") : calls.filter(turn);
    models.push({ role, model, openWeight: mine.length > 0 && mine.every((c) => c.model !== undefined && isOpenWeight(c.model)) });
  }
  const column: TrustReportColumn = {
    mode: r.mode,
    runId: r.runId,
    control: r.control,
    endUser: r.endUser,
    outcome: r.outcome,
    blockedActions: (r.policyDecisions ?? []).filter((d) => d.decision === "deny").length,
    guardrailHits: calls.filter(guardrailHit).length,
    fallbacks: calls.filter((c) => c.outcome === "fallback").length,
    drops: r.collector?.drops ?? 0,
    spendUsd: r.usage?.costUsd ?? 0,
    models,
    judgeFindings: (r.judgeFindings ?? []).map((f) => f.explanation),
  };
  if (r.finishedAt !== undefined) column.durationMs = Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt));
  return column;
}

/** Rubric columns in the order given, then the control columns: a control run never sits among the rubric ones. */
export function trustReportColumns(runs: readonly RunRecord[]): TrustReportColumn[] {
  const columns = runs.map(trustReportColumn);
  return [...columns.filter((c) => !c.control), ...columns.filter((c) => c.control)];
}

/** Every non-control column used only open-weight models. A control column never counts, in either direction. */
export const rubricModelsOnly = (columns: readonly TrustReportColumn[]): boolean =>
  columns.filter((c) => !c.control).every((c) => c.models.every((m) => m.openWeight));
