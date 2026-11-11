// The policy comparison is a pure function of the replayed golden runs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TimelineEvent } from "@rogueproof/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ENFORCER_GUARDRAIL, ENFORCER_TOOL_POLICY, comparisonView, leakCell } from "./compare";
import { loadReplay } from "./runs";
import { MODES, enforcerLabel, type ReplayView } from "./view";

const ev = (type: TimelineEvent["type"], over: Partial<TimelineEvent> = {}): TimelineEvent => ({ t: 0, type, summary: type, ...over });
const view = (events: TimelineEvent[], over: Partial<ReplayView> = {}): ReplayView => ({
  run: "safe", runId: "r", mode: "safe", profile: "rubric", outcome: "ok", endUser: "safe-run-1", runLabel: "safe-run-1", agentModel: "fake-model",
  costUsd: 0.5, endUserSpendUsd: 0.4, collector: { drops: 0, crossCheck: "match", fakeSecrets: [] }, guardrailBlockedRequestIds: [], events, problems: [], ...over,
});
const cell = (c: ReturnType<typeof comparisonView>, row: string, col: number) => {
  const r = c.rows.find((x) => x.key === row);
  return { text: r?.cells[col], tone: r?.tones[col], source: r?.source };
};

describe("comparisonView", () => {
  it("has one column per policy, in Defense Control's order, and one cell per column in every row", () => {
    const c = comparisonView({});
    expect(c.columns.map((x) => x.key)).toEqual(MODES.map((m) => m.key));
    for (const r of c.rows) {
      expect(r.cells).toHaveLength(MODES.length);
      expect(r.tones).toHaveLength(MODES.length);
    }
  });

  it("shows no number for a run that was not recorded", () => {
    const c = comparisonView({ safe: view([ev("done")]), permissive: null });
    expect(c.columns.map((x) => x.recorded)).toEqual([true, false, false]);
    for (const r of c.rows) expect(r.cells.slice(1)).toEqual(["not recorded", "not recorded"]);
  });

  it("counts denials and guardrail hits from the events, each under its own enforcer", () => {
    const safe = view([ev("deny"), ev("guardrail", { requestId: "a" }), ev("guardrail", { requestId: "b" }), ev("deny"), ev("done")], { guardrailBlockedRequestIds: ["b"] });
    const c = comparisonView({ safe, permissive: view([ev("done")]) });
    expect(cell(c, "blocked", 0)).toEqual({ text: "2", tone: "deny", source: ENFORCER_TOOL_POLICY });
    expect(cell(c, "blocked", 1)).toMatchObject({ text: "0", tone: null });
    expect(cell(c, "guardrail", 0)).toEqual({ text: "2 (1 refused · 1 flagged and served)", tone: null, source: ENFORCER_GUARDRAIL });
    expect(ENFORCER_TOOL_POLICY).not.toContain("Otari");
  });

  it("marks a leak red only on the collector's own, cross-checked count, naming keys and never values", () => {
    expect(leakCell(view([]))).toEqual({ text: "0", tone: null });
    expect(leakCell(view([], { collector: { drops: 2, crossCheck: "match", fakeSecrets: ["API_KEY", "DB_URL"] } }))).toEqual({ text: "2 drops · fake values of API_KEY, DB_URL", tone: "deny" });
    expect(leakCell(view([], { collector: { drops: 1, crossCheck: "match", fakeSecrets: [] } }))).toEqual({ text: "1 drop", tone: "deny" });
    expect(leakCell(view([], { collector: { drops: 1, crossCheck: "mismatch", fakeSecrets: [] } })).tone).toBeNull();
    expect(leakCell(view([], { collector: null }))).toEqual({ text: "not recorded", tone: null });
  });

  it("is green only for a completed mission", () => {
    const c = comparisonView({ safe: view([ev("done")]), budget: view([ev("budget")], { outcome: "budget_exceeded" }) });
    expect(cell(c, "outcome", 0)).toMatchObject({ text: "Mission completed (ok)", tone: "ok" });
    expect(cell(c, "outcome", 2)).toMatchObject({ text: "Stopped by budget (budget_exceeded)", tone: null });
  });

  it("never throws, whatever the events", () => {
    const types = ["search", "fetch", "read", "tool", "mcp", "deny", "guardrail", "judge", "post", "budget", "fallback", "step_cap", "done"] as const;
    const event = fc.record({ t: fc.nat(), type: fc.constantFrom(...types), summary: fc.string() });
    fc.assert(
      fc.property(fc.array(event, { maxLength: 30 }), (events) => {
        const c = comparisonView({ safe: view(events) });
        expect(Number(cell(c, "blocked", 0).text)).toBe(events.filter((e) => e.type === "deny").length);
      }),
    );
  });
});

describe("enforcerLabel", () => {
  it("names the tool policy for a deny and Otari's guardrail for a guardrail event, and nothing else", () => {
    expect(enforcerLabel("deny")).toBe(ENFORCER_TOOL_POLICY);
    expect(enforcerLabel("guardrail")).toBe(ENFORCER_GUARDRAIL);
    for (const t of ["search", "fetch", "read", "tool", "mcp", "judge", "post", "budget", "fallback", "step_cap", "done"] as const) expect(enforcerLabel(t)).toBeNull();
  });
});

describe("the golden runs, compared", () => {
  const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runs", "golden");
  it("matches run.json: run ids, denials by the tool policy, the collector's count", async () => {
    const loaded = Object.fromEntries(await Promise.all(MODES.map(async (m) => [m.key, await loadReplay(m.key, GOLDEN)] as const)));
    const c = comparisonView(loaded);
    MODES.forEach((m, i) => {
      const r = JSON.parse(readFileSync(join(GOLDEN, m.key, "run.json"), "utf8")) as { runId: string; policyDecisions: { decision: string }[]; collector: { drops: number } };
      expect(cell(c, "run", i).text).toBe(r.runId);
      expect(cell(c, "blocked", i).text).toBe(String(r.policyDecisions.filter((d) => d.decision === "deny").length));
      expect(cell(c, "leaked", i).text?.startsWith(String(r.collector.drops))).toBe(true);
    });
  });
});
