// Task 5.3: what the Trust Report page shows, derived from trust-report.json
// and nothing else. Pure: no I/O, no React. Every number is formatted from the
// file's own field; nothing is summed, rounded away or invented for display.
import type { TrustReport, TrustReportColumn } from "@rogueproof/shared";

export const CLOSING_LINE = "Same agent. Same attack. The only difference was the policy in Otari.";

const COLUMN_LABEL: Record<TrustReportColumn["mode"], string> = {
  safe: "Safe",
  permissive: "Permissive",
  budget: "Budget-limited",
  control: "Frontier control",
};

/** Heading of a column. A control run is always headed as one, whatever its mode says. */
export const columnLabel = (c: Pick<TrustReportColumn, "mode" | "control">): string => (c.control ? COLUMN_LABEL.control : COLUMN_LABEL[c.mode]);

/** USD with the six decimals trust-report.json carries. */
export const usd = (n: number | undefined): string => (n === undefined ? "n/a" : `$${n.toFixed(6)}`);
export const seconds = (ms: number | undefined): string => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

export type ModelBadge = "open-weight" | "frontier, non-rubric" | "open-weight, non-rubric" | "not open-weight";

/**
 * The badge next to a model. `openWeight` is the orchestrator's finding (what
 * the run requested, per role); a control run is never a rubric run, so its
 * badge says so either way.
 */
export function modelBadge(control: boolean, openWeight: boolean): ModelBadge {
  if (control) return openWeight ? "open-weight, non-rubric" : "frontier, non-rubric";
  return openWeight ? "open-weight" : "not open-weight";
}

export interface ModelView {
  role: string;
  model: string;
  badge: ModelBadge;
}

export interface ColumnView {
  /** Stable key for test ids: the mode, or `control`. */
  key: string;
  label: string;
  control: boolean;
  runId: string;
  models: ModelView[];
  /** The judge's explanations of denials, as recorded. The judge explains; it never decides a block. */
  judgeFindings: string[];
  /** http(s) links only: the file is data, and nothing else becomes an href. */
  traceLinks: string[];
}

export type RowTone = "deny" | "rescue";

export interface ReportRow {
  key: string;
  label: string;
  /** Who produced the number, when that is not obvious from the label. */
  source?: string;
  /** One cell per column, in column order. */
  cells: string[];
  /** Red for a denied action or a drop, green for a rescued fallback; only on a cell whose count is above zero. */
  tones: (RowTone | null)[];
}

export interface TrustReportView {
  generatedAt: string;
  verifiedLocally: boolean;
  rubricModelsOnly: boolean;
  /** `<column>: <role> <model>` for every non-control model not marked open-weight. Empty when the report is clean. */
  rubricViolations: string[];
  columns: ColumnView[];
  rows: ReportRow[];
  /** The report call (code execution on the `report` key), as recorded. */
  reportCall: { requestId: string | null; toolCallId: string | null; model: string | null; provider: string | null; fallback: boolean; costUsd: string };
  closingLine: string;
}

const isHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

/** Budget-limited runs on the capped key, which names no end user: `endUser` is then the run's label (decision 004). */
const endUserCell = (c: TrustReportColumn): string => (c.mode === "budget" && !c.control ? `${c.endUser} (run label; the capped key names no end user)` : c.endUser);

export function trustReportView(r: TrustReport): TrustReportView {
  const cols = r.columns;
  const keys = new Map<string, number>();
  const columns: ColumnView[] = cols.map((c) => {
    const base = c.control ? "control" : c.mode;
    const seen = keys.get(base) ?? 0;
    keys.set(base, seen + 1);
    return {
      key: seen === 0 ? base : `${base}-${seen + 1}`,
      label: columnLabel(c),
      control: c.control,
      runId: c.runId,
      models: c.models.map((m) => ({ role: m.role, model: m.model, badge: modelBadge(c.control, m.openWeight) })),
      judgeFindings: [...(c.judgeFindings ?? [])],
      traceLinks: (c.traceLinks ?? []).filter(isHttpUrl),
    };
  });
  const row = (key: string, label: string, cell: (c: TrustReportColumn) => string, opts: { source?: string; tone?: (c: TrustReportColumn) => RowTone | null } = {}): ReportRow => ({
    key,
    label,
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    cells: cols.map(cell),
    tones: cols.map((c) => opts.tone?.(c) ?? null),
  });
  const rows: ReportRow[] = [
    row("run", "Run", (c) => c.runId),
    row("end-user", "End user", endUserCell),
    row("outcome", "Outcome", (c) => c.outcome),
    row("blocked", "Blocked actions", (c) => String(c.blockedActions), { source: "tool policy, app-level, in the orchestrator", tone: (c) => (c.blockedActions > 0 ? "deny" : null) }),
    row("guardrail", "Guardrail hits", (c) => String(c.guardrailHits), { source: "Otari's inference guardrail" }),
    row("drops", "Collector drops", (c) => String(c.drops ?? 0), { source: "fake data; the collector's own count", tone: (c) => ((c.drops ?? 0) > 0 ? "deny" : null) }),
    row("fallbacks", "Fallbacks", (c) => String(c.fallbacks), { source: "Otari routing", tone: (c) => (c.fallbacks > 0 ? "rescue" : null) }),
    row("spend", "Spend, run", (c) => usd(c.spendUsd)),
    row("end-user-spend", "Spend, end user", (c) => usd(c.endUserSpendUsd), { source: "as Otari reported it after the run" }),
    row("duration", "Time to completion", (c) => seconds(c.durationMs)),
    row("judge-count", "Judge findings", (c) => String(c.judgeFindings?.length ?? 0), { source: "explanations of denials; quoted below" }),
  ];
  return {
    generatedAt: r.generatedAt,
    verifiedLocally: r.verifiedLocally,
    rubricModelsOnly: r.rubricModelsOnly,
    rubricViolations: cols.flatMap((c) => (c.control ? [] : c.models.filter((m) => !m.openWeight).map((m) => `${columnLabel(c)}: ${m.role} ${m.model}`))),
    columns,
    rows,
    reportCall: {
      requestId: r.codeExecutionRequestId ?? null,
      toolCallId: r.codeExecutionToolCallId ?? null,
      model: r.reportModel ?? null,
      provider: r.reportProvider ?? null,
      fallback: r.reportFallback === true,
      costUsd: usd(r.reportCostUsd),
    },
    closingLine: r.closingLine ?? CLOSING_LINE,
  };
}
