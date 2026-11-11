// Trust Report via code execution (task 4.4). Offline: the gateway is a fake
// fetch serving synthetic fixtures; the committed golden runs are the input.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTCOMES, type RunRecord } from "@rogueproof/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FAKE_ENV, fakeFetch, loadFixture, type Fixture } from "../../test/fixtures.js";
import { OtariClient, RunCounter, findRepoRoot, type ChatResult } from "../otari/index.js";
import { RunRefused } from "./scenario.js";
import {
  CLOSING_LINE, RUBRIC_MODES, assertReportRuns, buildProgram, diffComputation, generateTrustReport, localComputation, parseComputation,
  renderTrustReport, reportInput, validateTrustReport, type Computed,
} from "./trustReport.js";

const repoRoot = findRepoRoot(import.meta.dirname)!;
const golden = (mode: string): RunRecord => JSON.parse(readFileSync(join(repoRoot, "runs", "golden", mode, "run.json"), "utf8")) as RunRecord;
const goldens = (): RunRecord[] => RUBRIC_MODES.map(golden);
/** A synthetic control run: the Permissive golden run's shape on the dev profile (the real one is not in git). */
function control(): RunRecord {
  const r = golden("permissive");
  return {
    ...r, runId: "2026-01-01T00-00-00-000Z-control", mode: "control", control: true, golden: false, profile: "dev", endUser: "control-run-1",
    models: { agent: "fake-frontier-model" }, calls: (r.calls ?? []).map((c) => ({ ...c, model: "dev-primary" })),
  };
}
const runs = (): RunRecord[] => [...goldens(), control()];
const program = (): string => buildProgram(reportInput(runs()));

/** The code-execution fixture answering with `stdout`; its prose ("Blocked: 3, guardrail hits: 1.") is never a number source. */
function answer(stdout: string, code = program()): Fixture {
  const fx = loadFixture("ok", "code_execution");
  const body = fx.body as { otari_tool_calls: Record<string, unknown>[] };
  body.otari_tool_calls[0] = { ...body.otari_tool_calls[0], code, stdout };
  return fx;
}
const line = (c: Computed): string => `${JSON.stringify(c)}\n`;
function gateway(...fixtures: Fixture[]) {
  const ff = fakeFetch(fixtures);
  return { client: new OtariClient({ env: FAKE_ENV, fetch: ff.fetch, sleep: () => Promise.resolve() }), calls: ff.calls };
}
const NOW = () => new Date("2026-01-02T00:00:00.000Z");

describe("the report program against the local computation", () => {
  const python = spawnSync("python3", ["--version"]).status === 0;
  if (!python) console.log("skipped: python3 is not installed, so the report program is not run locally");

  it.skipIf(!python)("python3 running the program prints what trustColumn.ts computes for the golden runs and a control run", () => {
    const stdout = execFileSync("python3", ["-I", "-c", program()], { encoding: "utf8" });
    const computed = parseComputation(stdout);
    expect(computed).toBeDefined();
    expect(diffComputation(localComputation(runs()), computed!)).toEqual([]);
    expect(computed!.rubricModelsOnly).toBe(true);
  });

  it.skipIf(!python)("the program reports a dev-profile rubric column as not open-weight", () => {
    const dev = runs().map((r) => (r.mode === "safe" ? { ...r, profile: "dev" as const, calls: (r.calls ?? []).map((c) => ({ ...c, model: "dev-primary" })) } : r));
    const computed = parseComputation(execFileSync("python3", ["-I", "-c", buildProgram(reportInput(dev))], { encoding: "utf8" }))!;
    expect(computed.rubricModelsOnly).toBe(false);
    expect(diffComputation(localComputation(dev), computed)).toEqual([]);
  });

  it("the three rubric end users and the control are listed, rubric columns first", () => {
    const local = localComputation([control(), ...goldens()]);
    expect(local.columns.map((c) => [c.mode, c.control, c.endUser])).toEqual([
      ["safe", false, "safe-run-10"], ["permissive", false, "permissive-run-6"], ["budget", false, "budget-run-1"], ["control", true, "control-run-1"],
    ]);
    expect(local.rubricModelsOnly).toBe(true);
    // The golden runs' own numbers: Safe blocked something, Budget-limited ended on the gateway's refusal.
    expect(local.columns[0]!.blockedActions).toBeGreaterThan(0);
    expect(local.columns[2]!.outcome).toBe("budget_exceeded");
    expect(local.columns[2]!.endUserSpendMicroUsd).toBeNull();
  });

  it("what is sent is a summary: no URL, no fake secret, no key, no header", () => {
    const p = program();
    for (const banned of ["http", "FAKE", "otk_", "tk-", "gw_", "Bearer", "lakera", "curl"]) expect(p, banned).not.toContain(banned);
    expect(p.length).toBeLessThan(12_000);
  });
});

describe("generateTrustReport", () => {
  it("sends one report-key call with otari_code_execution and nothing else, and takes the numbers from stdout", async () => {
    const local = localComputation(runs());
    const { client, calls } = gateway(answer(line(local)));
    const r = await generateTrustReport({ client, runs: runs(), now: NOW });
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body["tools"]).toEqual([{ type: "otari_code_execution" }]);
    expect(body).not.toHaveProperty("mcp_server_ids");
    expect(body).not.toHaveProperty("user");
    expect(body["model"]).toBe("report-primary");
    expect(body["max_tokens"]).toBeGreaterThan(0);
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${FAKE_ENV.keys.report}`);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validateTrustReport(r.report)).toEqual([]);
    expect(r.report).toMatchObject({
      generatedAt: "2026-01-02T00:00:00.000Z", verifiedLocally: true, rubricModelsOnly: true, closingLine: CLOSING_LINE,
      codeExecutionRequestId: "req_fake_0001", codeExecutionToolCallId: "otari_ci_fake0001", reportModel: "fake/model-a", reportFallback: false,
    });
    expect(r.programUnchanged).toBe(true);
    expect(r.report.columns.map((c) => c.endUser)).toEqual(["safe-run-10", "permissive-run-6", "budget-run-1", "control-run-1"]);
    expect(r.report.columns.map((c) => c.blockedActions)).toEqual(local.columns.map((c) => c.blockedActions));
    expect(r.report.columns[0]!.spendUsd).toBe(local.columns[0]!.spendMicroUsd / 1e6);
    expect(r.report.columns[2]).not.toHaveProperty("endUserSpendUsd");
    expect(r.report.columns[3]!.models).toEqual([{ role: "agent", model: "fake-frontier-model", openWeight: false }]);
    const md = renderTrustReport(r.report, { programUnchanged: r.programUnchanged });
    for (const u of ["safe-run-10", "permissive-run-6", "budget-run-1", "control-run-1", "not a rubric run", CLOSING_LINE]) expect(md).toContain(u);
  });

  it("fails on a mismatch and names the number", async () => {
    const wrong = localComputation(runs());
    wrong.columns[0]!.blockedActions += 1;
    const { client } = gateway(answer(line(wrong)));
    const r = await generateTrustReport({ client, runs: runs() });
    expect(r).toMatchObject({ ok: false, failure: "mismatch" });
    if (!r.ok) expect(r.diff).toEqual([expect.stringMatching(/^\$\.columns\[0\]\.blockedActions: stdout \d+, local \d+$/)]);
  });

  it("the model's prose is never the source: right numbers in the message without a code-execution entry are refused", async () => {
    const fx = loadFixture("ok", "hello");
    (fx.body as { choices: { message: { content: string } }[] }).choices[0]!.message.content = line(localComputation(runs()));
    const r = await generateTrustReport({ client: gateway(fx).client, runs: runs() });
    expect(r).toMatchObject({ ok: false, failure: "no_code_execution" });
  });

  it("stdout that is not the program's JSON line is refused", async () => {
    const r = await generateTrustReport({ client: gateway(answer("3\n")).client, runs: runs() });
    expect(r).toMatchObject({ ok: false, failure: "unreadable_stdout" });
  });

  it("a failed attempt next to a completed one still leaves stdout to verify; a failed one alone does not", async () => {
    const failed = { id: "otari_ci_fake0000", type: "code_execution", status: "failed", code: "x", stdout: "", stderr: "boom", exit_code: 1, file_ids: [] };
    const both = answer(line(localComputation(runs())));
    (both.body as { otari_tool_calls: unknown[] }).otari_tool_calls.unshift(failed);
    const ok = await generateTrustReport({ client: gateway(both).client, runs: runs() });
    expect(ok.call.outcome).toBe("tool_error");
    expect(ok.ok).toBe(true);

    const alone = answer("");
    (alone.body as { otari_tool_calls: unknown[] }).otari_tool_calls = [failed];
    expect(await generateTrustReport({ client: gateway(alone).client, runs: runs() })).toMatchObject({ ok: false, failure: "tool_error" });
  });

  it("branches on every outcome: only ok and fallback (and a tool_error with a completed entry) reach the numbers", async () => {
    const good = line(localComputation(runs()));
    const rescued = answer(good);
    rescued.headers["otari-fallback"] = "true";
    const fixtures: Record<(typeof OUTCOMES)[number], Fixture | undefined> = {
      ok: answer(good),
      fallback: rescued,
      guardrail_blocked: loadFixture("guardrail_blocked", "injection"),
      budget_exceeded: loadFixture("budget_exceeded", "key-budget"),
      tool_error: loadFixture("tool_error", "fetch-failed"),
      error: loadFixture("error", "provider-not-configured-424"),
      step_cap: undefined,
    };
    for (const outcome of OUTCOMES) {
      const fx = fixtures[outcome];
      let r;
      if (fx === undefined) {
        // The cap is the run's, not a call's: a client whose counter is spent answers step_cap without sending.
        const { client, calls } = gateway();
        const spent = new RunCounter(0);
        r = await generateTrustReport({ client: { chat: (role, messages, o) => client.chat(role, messages, { ...o, counter: spent }) }, runs: runs() });
        expect(calls).toHaveLength(0);
      } else {
        const { client, calls } = gateway(fx);
        r = await generateTrustReport({ client, runs: runs() });
        expect(calls, outcome).toHaveLength(1); // never retried
      }
      expect(r.call.outcome, outcome).toBe(outcome);
      if (outcome === "ok" || outcome === "fallback") {
        expect(r.ok, outcome).toBe(true);
        if (r.ok) expect(r.report.reportFallback).toBe(outcome === "fallback");
      } else {
        expect(r, outcome).toMatchObject({ ok: false, failure: outcome });
      }
    }
  });
});

describe("assertReportRuns", () => {
  const never = { chat: (): Promise<ChatResult> => Promise.reject(new Error("the gateway must not be called")) };

  it("accepts the golden runs with a control run", () => {
    expect(() => assertReportRuns(runs())).not.toThrow();
  });

  it("fails on a dev-profile run before anything is sent", async () => {
    const devProfile = runs().map((r) => (r.mode === "safe" ? { ...r, profile: "dev" as const } : r));
    expect(() => assertReportRuns(devProfile)).toThrow(RunRefused);
    expect(() => assertReportRuns(devProfile)).toThrow(/MODEL_PROFILE=dev/);
    await expect(generateTrustReport({ client: never, runs: devProfile })).rejects.toThrow(RunRefused);
    // The profile field alone is not trusted: a call on a non-open-weight model fails it too.
    const devCalls = runs().map((r) => (r.mode === "budget" ? { ...r, calls: (r.calls ?? []).map((c) => ({ ...c, model: "dev-primary" })) } : r));
    expect(() => assertReportRuns(devCalls)).toThrow(/open-weight/);
  });

  it("needs exactly one golden run per rubric mode, and never takes an unlabelled control run", () => {
    expect(() => assertReportRuns(goldens().slice(0, 2))).toThrow(/exactly one golden budget run/);
    expect(() => assertReportRuns([...goldens(), golden("safe")])).toThrow(/exactly one golden safe run/);
    expect(() => assertReportRuns([...goldens(), { ...control(), control: false }])).toThrow(RunRefused);
    expect(() => assertReportRuns(goldens().map((r) => ({ ...r, golden: false })))).toThrow(/not a golden run/);
  });
});

describe("parseComputation (external input)", () => {
  it("never throws, whatever stdout holds", () => {
    fc.assert(fc.property(fc.oneof(fc.string(), fc.json(), fc.jsonValue().map((v) => JSON.stringify({ columns: v, rubricModelsOnly: true }))), (s) => {
      const c = parseComputation(s);
      expect(c === undefined || Array.isArray(c.columns)).toBe(true);
    }));
  });

  it("reads the last non-empty line and rejects an off-shape column", () => {
    const local = localComputation(runs());
    expect(parseComputation(`a warning\n${JSON.stringify(local)}\n\n`)).toEqual(local);
    for (const bad of [{ blockedActions: -1 }, { blockedActions: 1.5 }, { outcome: "blocked" }, { mode: "other" }, { models: [{ role: "agent" }] }, { durationMs: "9" }]) {
      const broken = { ...local, columns: [{ ...local.columns[0]!, ...bad }] };
      expect(parseComputation(JSON.stringify(broken)), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
