// Task 5.3: the Trust Report view shows trust-report.json's own numbers, and
// its rubric columns hold only models A/B/C. Offline. The synthetic report has
// fake ids, costs and model names; the recorded one (runs/trust-report.json,
// tracked next to the golden runs it was computed from) is checked too.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TrustReport, TrustReportColumn } from "@rogueproof/shared";
import { loadTrustReport, readTrustReport, trustReportFile } from "./runs";
import { CLOSING_LINE, columnLabel, modelBadge, seconds, trustReportView, usd, type TrustReportView } from "./trustReport";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REAL = join(ROOT, "runs", "trust-report.json");

const column = (over: Partial<TrustReportColumn> & Pick<TrustReportColumn, "mode">): TrustReportColumn => ({
  runId: `run-${over.mode}`,
  control: false,
  endUser: `${over.mode}-run-1`,
  outcome: "ok",
  blockedActions: 0,
  guardrailHits: 0,
  fallbacks: 0,
  spendUsd: 0,
  models: [{ role: "agent", model: "fake/open-a", openWeight: true }],
  ...over,
});

const SYNTHETIC: TrustReport = {
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  rubricModelsOnly: true,
  verifiedLocally: true,
  codeExecutionRequestId: "req-fake",
  codeExecutionToolCallId: "otari_ci_fake",
  reportModel: "fake/open-b",
  reportProvider: "fakeprovider",
  reportFallback: false,
  reportCostUsd: 0.001234,
  columns: [
    column({
      mode: "safe",
      blockedActions: 3,
      guardrailHits: 7,
      fallbacks: 1,
      drops: 0,
      spendUsd: 0.0123,
      endUserSpendUsd: 0.012,
      durationMs: 12345,
      models: [
        { role: "agent", model: "fake/open-a", openWeight: true },
        { role: "judge", model: "fake/open-c", openWeight: true },
      ],
      judgeFindings: ["The call would have read .env…", "The call would have posted outward…", "A third finding."],
      traceLinks: ["https://example.test/trace/1", "javascript:alert(1)", "not a url"],
    }),
    column({ mode: "permissive", guardrailHits: 2, drops: 2, spendUsd: 0.5, endUserSpendUsd: 0.5, durationMs: 1000 }),
    column({ mode: "budget", outcome: "budget_exceeded", blockedActions: 1, spendUsd: 0.000001 }),
    column({ mode: "permissive", control: true, endUser: "control-run-1", spendUsd: 1.5, endUserSpendUsd: 1.5, models: [{ role: "agent", model: "fake/frontier-d", openWeight: false }] }),
  ],
};

/** Every number the view shows must be the file's own field, formatted and nothing more. */
function expectNumbersEqual(view: TrustReportView, r: TrustReport): void {
  const cells = (key: string): string[] => {
    const row = view.rows.find((x) => x.key === key);
    if (!row) throw new Error(`no row ${key}`);
    expect(row.cells).toHaveLength(r.columns.length);
    return row.cells;
  };
  const cols = r.columns;
  expect(cells("run")).toEqual(cols.map((c) => c.runId));
  expect(cells("outcome")).toEqual(cols.map((c) => c.outcome));
  expect(cells("blocked").map(Number)).toEqual(cols.map((c) => c.blockedActions));
  expect(cells("guardrail").map(Number)).toEqual(cols.map((c) => c.guardrailHits));
  expect(cells("fallbacks").map(Number)).toEqual(cols.map((c) => c.fallbacks));
  expect(cells("drops").map(Number)).toEqual(cols.map((c) => c.drops ?? 0));
  expect(cells("judge-count").map(Number)).toEqual(cols.map((c) => c.judgeFindings?.length ?? 0));
  // Six decimals: what the report itself carries, so parsing the cell gives the number back.
  expect(cells("spend").map((s) => Number(s.slice(1)))).toEqual(cols.map((c) => Number(c.spendUsd.toFixed(6))));
  expect(cells("end-user-spend")).toEqual(cols.map((c) => (c.endUserSpendUsd === undefined ? "n/a" : `$${c.endUserSpendUsd.toFixed(6)}`)));
  expect(cells("duration")).toEqual(cols.map((c) => (c.durationMs === undefined ? "n/a" : `${(c.durationMs / 1000).toFixed(1)} s`)));
  cells("end-user").forEach((cell, i) => expect(cell.startsWith(cols[i]!.endUser)).toBe(true));
  expect(view.columns.map((c) => c.judgeFindings)).toEqual(cols.map((c) => c.judgeFindings ?? []));
  expect(view.columns.map((c) => c.models.map((m) => [m.role, m.model]))).toEqual(cols.map((c) => c.models.map((m) => [m.role, m.model])));
  expect(view.generatedAt).toBe(r.generatedAt);
  expect(view.verifiedLocally).toBe(r.verifiedLocally);
  expect(view.rubricModelsOnly).toBe(r.rubricModelsOnly);
  expect(view.reportCall.requestId).toBe(r.codeExecutionRequestId ?? null);
  expect(view.reportCall.toolCallId).toBe(r.codeExecutionToolCallId ?? null);
  expect(view.reportCall.costUsd).toBe(usd(r.reportCostUsd));
}

describe("Trust Report view", () => {
  const view = trustReportView(SYNTHETIC);

  it("shows the JSON's numbers, column by column", () => {
    expectNumbersEqual(view, SYNTHETIC);
    expect(view.rows.find((r) => r.key === "spend")?.cells).toEqual(["$0.012300", "$0.500000", "$0.000001", "$1.500000"]);
  });

  it("heads the columns Safe / Permissive / Budget-limited / Frontier control", () => {
    expect(view.columns.map((c) => c.label)).toEqual(["Safe", "Permissive", "Budget-limited", "Frontier control"]);
    expect(view.columns.map((c) => c.key)).toEqual(["safe", "permissive", "budget", "control"]);
    expect(columnLabel({ mode: "control", control: true })).toBe("Frontier control");
  });

  it("badges rubric models open-weight and the control model frontier, non-rubric", () => {
    expect(view.columns.filter((c) => !c.control).flatMap((c) => c.models.map((m) => m.badge))).toEqual(["open-weight", "open-weight", "open-weight", "open-weight"]);
    expect(view.columns[3]?.models.map((m) => m.badge)).toEqual(["frontier, non-rubric"]);
    expect(view.rubricViolations).toEqual([]);
    expect(modelBadge(true, true)).toBe("open-weight, non-rubric");
  });

  it("names a rubric model that is not open-weight instead of badging it", () => {
    const bad = trustReportView({ ...SYNTHETIC, columns: [column({ mode: "safe", models: [{ role: "agent", model: "fake/frontier-d", openWeight: false }] }), SYNTHETIC.columns[3]!] });
    expect(bad.columns[0]?.models[0]?.badge).toBe("not open-weight");
    expect(bad.rubricViolations).toEqual(["Safe: agent fake/frontier-d"]);
  });

  it("says the Budget-limited end user is a run label (decision 004) and has no end-user spend", () => {
    const i = SYNTHETIC.columns.findIndex((c) => c.mode === "budget");
    expect(view.rows.find((r) => r.key === "end-user")?.cells[i]).toBe("budget-run-1 (run label; the capped key names no end user)");
    expect(view.rows.find((r) => r.key === "end-user-spend")?.cells[i]).toBe("n/a");
  });

  it("colours only a denial or a drop red and a fallback green", () => {
    const tones = (key: string) => view.rows.find((r) => r.key === key)?.tones;
    expect(tones("blocked")).toEqual(["deny", null, "deny", null]);
    expect(tones("drops")).toEqual([null, "deny", null, null]);
    expect(tones("fallbacks")).toEqual(["rescue", null, null, null]);
    expect(tones("guardrail")).toEqual([null, null, null, null]);
  });

  it("links only http(s) trace links", () => {
    expect(view.columns[0]?.traceLinks).toEqual(["https://example.test/trace/1"]);
    expect(view.columns[1]?.traceLinks).toEqual([]);
  });

  it("ends on the closing line", () => {
    expect(CLOSING_LINE).toBe("Same agent. Same attack. The only difference was the policy in Otari.");
    expect(view.closingLine).toBe(CLOSING_LINE);
  });

  it("formats absent numbers as n/a", () => {
    expect(usd(undefined)).toBe("n/a");
    expect(seconds(undefined)).toBe("n/a");
    expect(seconds(286985)).toBe("287.0 s");
  });

  it("holds for any report: one cell per column and the counts as given", () => {
    const arbColumn = fc.record({
      mode: fc.constantFrom("safe" as const, "permissive" as const, "budget" as const, "control" as const),
      control: fc.boolean(),
      blockedActions: fc.nat(1000),
      guardrailHits: fc.nat(1000),
      fallbacks: fc.nat(1000),
      spendUsd: fc.double({ min: 0, max: 100, noNaN: true }),
      endUser: fc.string(),
      judgeFindings: fc.array(fc.string(), { maxLength: 4 }),
      traceLinks: fc.array(fc.oneof(fc.webUrl(), fc.string()), { maxLength: 3 }),
    });
    fc.assert(
      fc.property(fc.array(arbColumn, { maxLength: 6 }), (cols) => {
        const r: TrustReport = { ...SYNTHETIC, columns: cols.map((c) => column(c)) };
        const v = trustReportView(r);
        expectNumbersEqual(v, r);
        expect(new Set(v.columns.map((c) => c.key)).size).toBe(cols.length);
        for (const c of v.columns) for (const href of c.traceLinks) expect(href).toMatch(/^https?:/i);
      }),
    );
  });
});

describe("Trust Report file", () => {
  it("accepts a valid report and refuses anything else without throwing", async () => {
    expect(await readTrustReport(JSON.stringify(SYNTHETIC))).toEqual({ status: "ok", report: SYNTHETIC });
    expect(await readTrustReport("{")).toEqual({ status: "invalid", problems: ["not JSON"] });
    const wrong = await readTrustReport(JSON.stringify({ ...SYNTHETIC, columns: [{ mode: "safe" }] }));
    expect(wrong.status).toBe("invalid");
    expect(await loadTrustReport(join(ROOT, "runs", "no-such-report.json"))).toEqual({ status: "missing" });
  });

  it("never throws on arbitrary text", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string(), fc.json()), async (text) => {
        const r = await readTrustReport(text);
        expect(["ok", "invalid"]).toContain(r.status);
      }),
      { numRuns: 200 },
    );
  });

  it("is runs/trust-report.json, or TRUST_REPORT_FILE", () => {
    expect(trustReportFile(ROOT, {})).toBe(REAL);
    expect(trustReportFile(join(ROOT, "apps", "dashboard"), {})).toBe(REAL);
    expect(trustReportFile(ROOT, { TRUST_REPORT_FILE: "/somewhere/else.json" })).toBe("/somewhere/else.json");
  });
});

interface RoutingEntry {
  model?: string;
  providerModel?: string;
}

/** Provider model name -> rubric letter, from otari-config: every routing entry whose model is A, B or C in models.json. */
function rubricProviderModels(): Map<string, string> {
  const roles = (JSON.parse(readFileSync(join(ROOT, "otari-config", "models.json"), "utf8")) as { roles: Record<string, { id: string }> }).roles;
  const letterOf = new Map(["A", "B", "C"].map((l) => [roles[l]!.id, l]));
  const out = new Map<string, string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    const e = v as RoutingEntry;
    const letter = typeof e.model === "string" ? letterOf.get(e.model) : undefined;
    if (typeof e.providerModel === "string" && letter !== undefined) out.set(e.providerModel, letter);
    Object.values(v).forEach(walk);
  };
  const dir = join(ROOT, "otari-config", "routing");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) walk(JSON.parse(readFileSync(join(dir, f), "utf8")));
  return out;
}

describe("the recorded Trust Report", () => {
  it("is valid, and the view's numbers equal it", async () => {
    const loaded = await loadTrustReport(REAL);
    if (loaded.status !== "ok") throw new Error(`runs/trust-report.json: ${JSON.stringify(loaded)}`);
    expectNumbersEqual(trustReportView(loaded.report), loaded.report);
  });

  it("is about the golden runs in runs/golden", async () => {
    const loaded = await loadTrustReport(REAL);
    if (loaded.status !== "ok") throw new Error("invalid report");
    for (const c of loaded.report.columns.filter((x) => !x.control)) {
      const golden = JSON.parse(readFileSync(join(ROOT, "runs", "golden", c.mode, "run.json"), "utf8")) as { runId: string };
      expect(c.runId, `${c.mode} column`).toBe(golden.runId);
    }
  });

  it("has rubric columns on models A/B/C only, and badges the control run frontier, non-rubric", async () => {
    const loaded = await loadTrustReport(REAL);
    if (loaded.status !== "ok") throw new Error("invalid report");
    const known = rubricProviderModels();
    expect(new Set(known.values())).toEqual(new Set(["A", "B", "C"]));
    const view = trustReportView(loaded.report);
    const rubric = view.columns.filter((c) => !c.control);
    expect(rubric.map((c) => c.label)).toEqual(["Safe", "Permissive", "Budget-limited"]);
    for (const c of rubric) {
      expect(c.models.length).toBeGreaterThan(0);
      for (const m of c.models) {
        expect(known.has(m.model), `${c.label} ${m.role} ${m.model} is not model A, B or C`).toBe(true);
        expect(m.badge).toBe("open-weight");
      }
    }
    expect(view.rubricViolations).toEqual([]);
    expect(view.rubricModelsOnly).toBe(true);
    for (const c of view.columns.filter((x) => x.control)) for (const m of c.models) expect(m.badge).toBe("frontier, non-rubric");
  });
});
