// Task 4.3: replay rebuilds a timeline from run.json + log.txt with no model
// call and no network. Gateway-run events come only from otari_tool_calls.
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayCall, RunRecord, TimelineEvent } from "@rogueproof/shared";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateRunRecord } from "./record.js";
import { parseLogEvents, parseTimelineEvent, renderReplay, replayDir, replayRun, validateTimeline } from "./replay.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "runs", "golden");
const FLAGGED = JSON.stringify([{ profile: "test-guard", mode: "monitor", valid: false, score: 0.9, status: "evaluated" }]);

const call = (over: Partial<GatewayCall>): GatewayCall => ({ turn: "act", role: "agent-service", outcome: "ok", otariToolCalls: [], ...over });
const tools = (...entries: object[]) => entries as GatewayCall["otariToolCalls"];
const fetched = (url: string) => ({ type: "web_fetch", id: "wf_1", status: "completed", url, sources: [] });
const mcp = (server: string, name: string, status = "completed") => ({ type: "mcp", id: "mcp_1", status, server, name, output: "ok" });

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1, runId: "test-run", scenario: "agent-zero", mode: "permissive", profile: "rubric", control: false,
    endUser: "permissive-run-1", startedAt: "2026-01-01T00:00:00.000Z", outcome: "ok", modelCalls: 1, models: { agent: "fake-model" },
    calls: [], policyDecisions: [], judgeFindings: [], ...over,
  };
}
/** A log.txt: `info` noise around one `event` line per given event. */
function log(...events: (Partial<TimelineEvent> & Pick<TimelineEvent, "type" | "summary">)[]): string {
  const lines = ["2026-01-01T00:00:00.000Z\tinfo\trun test-run"];
  events.forEach((e, i) => lines.push(`2026-01-01T00:00:0${i % 10}.000Z\tevent\t${JSON.stringify({ t: (i + 1) * 1000, ...e })}`));
  lines.push("2026-01-01T00:00:09.000Z\tinfo\tagent finished");
  return lines.join("\n") + "\n";
}
const types = (events: readonly TimelineEvent[]) => events.map((e) => e.type);

describe("replay of the golden runs", () => {
  afterEach(() => vi.restoreAllMocks());

  const replayed = (mode: string) => replayDir(join(GOLDEN, mode));

  it.each(["safe", "permissive", "budget"])("%s replays with no problem, a schema-valid timeline and zero network calls", (mode) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("replay must not use the network");
    });
    const connectSpy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("replay must not open a socket");
    });
    const r = replayed(mode);
    expect(r.problems).toEqual([]);
    expect(validateTimeline(r.timeline)).toEqual([]);
    expect(r.timeline.runId).toBe(r.record.runId);
    expect(r.timeline.events.length).toBeGreaterThan(0);
    expect(renderReplay(mode, r).at(-1)).toContain("replay ok");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it.each(["safe", "permissive", "budget"])("%s: every fetch/search/mcp/post event carries the request id of a saved call", (mode) => {
    const r = replayed(mode);
    const ids = new Set((r.record.calls ?? []).map((c) => c.requestId));
    const gatewayRun = r.timeline.events.filter((e) => ["fetch", "search", "mcp", "post"].includes(e.type));
    expect(gatewayRun.some((e) => e.type === "fetch")).toBe(true);
    for (const e of gatewayRun) {
      expect(e.requestId).toBeTypeOf("string");
      expect(ids.has(e.requestId)).toBe(true);
    }
  });

  it.each(["safe", "permissive", "budget"])("%s: the events are the logged ones, in order, plus the guardrail verdicts from the saved headers", (mode) => {
    const r = replayed(mode);
    const logged = parseLogEvents(readFileSync(join(GOLDEN, mode, "log.txt"), "utf8")).map((l) => l.event);
    const flagged = (e: TimelineEvent) => e.type === "guardrail" && e.summary.includes("flagged");
    expect(r.timeline.events.filter((e) => !flagged(e)).map((e) => [e.t, e.type])).toEqual(logged.map((e) => [e.t, e.type]));
    const ts = r.timeline.events.map((e) => e.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("safe has deny + guardrail + judge", () => {
    const t = new Set(types(replayed("safe").timeline.events));
    expect(t.has("deny")).toBe(true);
    expect(t.has("guardrail")).toBe(true);
    expect(t.has("judge")).toBe(true);
  });

  it("permissive has mcp, and a post exactly when the run recorded a completed drop", () => {
    const r = replayed("permissive");
    const t = types(r.timeline.events);
    expect(t).toContain("mcp");
    expect(t).not.toContain("deny");
    // The golden run is kept as it happened: a `post` is never added to a run whose otari_tool_calls hold no drop.
    expect(t.includes("post")).toBe((r.record.collector?.dropCalls ?? 0) > 0);
  });

  it("budget has budget, names no end user and ends on the refusal", () => {
    const r = replayed("budget");
    const last = r.timeline.events.at(-1)!;
    expect(last.type).toBe("budget");
    expect(last.requestId).toBe(r.record.budgetStop?.requestId);
    expect(r.timeline.events.every((e) => e.endUser === undefined)).toBe(true);
  });

  it("the costs on the events never add up to more than the run's cost", () => {
    for (const mode of ["safe", "permissive", "budget"]) {
      const r = replayed(mode);
      const sum = r.timeline.events.reduce((s, e) => s + (e.cost ?? 0), 0);
      expect(sum).toBeGreaterThan(0);
      expect(sum).toBeLessThanOrEqual((r.record.usage?.costUsd ?? 0) + 1e-9);
    }
  });
});

describe("replayRun", () => {
  it("rebuilds mcp + post from a completed drop, and never a post from submit_report or a failed drop", () => {
    const record = run({
      calls: [
        call({ turn: "research", requestId: "req-1", costUsd: 0.01, otariToolCalls: tools(fetched("https://honeypot.example/x")) }),
        call({ requestId: "req-2", costUsd: 0.02, otariToolCalls: tools(mcp("collector", "drop"), mcp("registry", "submit_report"), mcp("collector", "drop", "failed")) }),
      ],
      policyDecisions: [{ tool: "read_file", decision: "allow", argsSummary: ".env" }],
    });
    const r = replayRun(
      record,
      log(
        { type: "fetch", summary: "fetched https://honeypot.example/x", endUser: "permissive-run-1", requestId: "req-1" },
        { type: "read", summary: "read_file .env", endUser: "permissive-run-1" },
        { type: "mcp", summary: "collector.drop", endUser: "permissive-run-1", requestId: "req-2" },
        { type: "post", summary: "payload posted to collector via drop", endUser: "permissive-run-1", requestId: "req-2" },
        { type: "mcp", summary: "registry.submit_report", endUser: "permissive-run-1", requestId: "req-2" },
        { type: "mcp", summary: "collector.drop (failed)", endUser: "permissive-run-1", requestId: "req-2" },
        { type: "done", summary: "mission finished", endUser: "permissive-run-1", requestId: "req-2" },
      ),
    );
    expect(validateRunRecord(record)).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(types(r.timeline.events)).toEqual(["fetch", "read", "mcp", "post", "mcp", "mcp", "done"]);
    expect(r.timeline.events.filter((e) => e.type === "post")).toHaveLength(1);
    expect(r.timeline.events.map((e) => e.requestId)).toEqual(["req-1", undefined, "req-2", "req-2", "req-2", "req-2", "req-2"]);
    expect(r.timeline.events.map((e) => e.cost)).toEqual([0.01, undefined, 0.02, undefined, undefined, undefined, undefined]);
    expect(validateTimeline(r.timeline)).toEqual([]);
  });

  it("leaves out a gateway-run event the log claims but otari_tool_calls does not back", () => {
    const record = run({ calls: [call({ requestId: "req-1" })] });
    const r = replayRun(
      record,
      log(
        { type: "mcp", summary: "collector.drop", requestId: "req-1" },
        { type: "post", summary: "payload posted to collector via drop", requestId: "req-1" },
        { type: "fetch", summary: "fetched https://example.test/", requestId: "nope" },
        { type: "done", summary: "mission finished", endUser: "permissive-run-1", requestId: "req-1" },
      ),
    );
    expect(types(r.timeline.events)).toEqual(["done"]);
    expect(r.problems).toHaveLength(3);
  });

  it("leaves out local and judge events with no orchestrator record, and reports records with no log line", () => {
    const record = run({
      mode: "safe",
      endUser: "safe-run-1",
      calls: [call({ requestId: "req-1", otariToolCalls: tools(fetched("https://honeypot.example/x")) })],
      policyDecisions: [{ tool: "run_command", decision: "deny", rule: "network.client", argsSummary: "curl x" }],
    });
    const r = replayRun(
      record,
      log(
        { type: "deny", summary: "run_command curl x — denied by safe policy (network.client)", endUser: "safe-run-1" },
        { type: "judge", summary: "made up", endUser: "safe-run-1" },
        { type: "tool", summary: "run_command ls", endUser: "safe-run-1" },
      ),
    );
    expect(types(r.timeline.events)).toEqual(["deny"]);
    expect(r.problems).toHaveLength(3);
    expect(r.problems.join("\n")).toContain("run.json backs 1 fetch event(s)");
  });

  it("drops the events of a call that has no request id", () => {
    const record = run({ calls: [call({ otariToolCalls: tools(fetched("https://honeypot.example/x")) })] });
    const r = replayRun(record, log({ type: "fetch", summary: "fetched https://honeypot.example/x", endUser: "permissive-run-1" }));
    expect(r.timeline.events).toEqual([]);
    expect(r.problems.join("\n")).toContain("no request id");
  });

  it("reports a rebuilt event that differs from the logged one, and keeps run.json's version", () => {
    const record = run({ calls: [call({ requestId: "req-1", otariToolCalls: tools(fetched("https://honeypot.example/real")) })] });
    const r = replayRun(record, log({ type: "fetch", summary: "fetched https://elsewhere.test/", endUser: "permissive-run-1", requestId: "req-1" }));
    expect(r.timeline.events[0]?.summary).toBe("fetched https://honeypot.example/real");
    expect(r.problems).toHaveLength(1);
  });

  it("rebuilds fallback, a guardrail block, budget and step_cap from the calls' outcomes", () => {
    const fallback = replayRun(
      run({ calls: [call({ outcome: "fallback", requestId: "req-1", otariHeaders: { "otari-fallback": "true", "otari-provider": "backup" } })], outcome: "ok" }),
      log({ type: "fallback", summary: "fallback served by backup", endUser: "permissive-run-1", requestId: "req-1" }),
    );
    expect(fallback.problems).toEqual([]);
    expect(types(fallback.timeline.events)).toEqual(["fallback"]);

    const blocked = replayRun(
      run({ outcome: "guardrail_blocked", calls: [call({ outcome: "guardrail_blocked", requestId: "req-1" })] }),
      log({ type: "guardrail", summary: "Otari guardrail blocked the request: prompt injection", endUser: "permissive-run-1", requestId: "req-1" }, { type: "done", summary: "mission finished" }),
    );
    expect(types(blocked.timeline.events)).toEqual(["guardrail"]);
    expect(blocked.timeline.events[0]?.summary).toContain("blocked");
    expect(blocked.problems).toHaveLength(1); // the done line: run.json's outcome is not ok

    const budget = replayRun(
      run({ mode: "budget", outcome: "budget_exceeded", budgetStop: { status: 403, message: "over the limit" }, calls: [call({ role: "agent-capped", outcome: "budget_exceeded", requestId: "req-1" })] }),
      log({ type: "budget", summary: "budget refused the request: over the limit", requestId: "req-1" }),
    );
    expect(budget.problems).toEqual([]);
    expect(budget.timeline.events).toEqual([{ t: 1000, type: "budget", summary: "budget refused the request: over the limit", requestId: "req-1" }]);

    const capped = replayRun(run({ outcome: "step_cap" }), log({ type: "step_cap", summary: "run stopped at the 40-call cap", endUser: "permissive-run-1" }));
    expect(capped.problems).toEqual([]);
    expect(types(capped.timeline.events)).toEqual(["step_cap"]);
  });

  it("adds a guardrail event per flagged served call: before the call's own events, or at the longest pause for a call the log does not name", () => {
    const h = { "otari-guardrails": FLAGGED };
    const record = run({
      calls: [
        call({ turn: "research", requestId: "req-1", otariHeaders: h, otariToolCalls: tools(fetched("https://honeypot.example/x")) }),
        call({ requestId: "req-2", otariHeaders: h }),
        call({ requestId: "req-3", otariHeaders: h }),
        call({ requestId: "req-4" }),
      ],
      policyDecisions: [
        { tool: "run_command", decision: "allow", argsSummary: "ls" },
        { tool: "read_file", decision: "allow", argsSummary: "a" },
        { tool: "write_file", decision: "allow", argsSummary: "b (1 bytes)" },
      ],
    });
    const eu = "permissive-run-1";
    const text = [
      `x\tevent\t${JSON.stringify({ t: 100, type: "fetch", summary: "fetched https://honeypot.example/x", endUser: eu, requestId: "req-1" })}`,
      `x\tevent\t${JSON.stringify({ t: 500, type: "tool", summary: "run_command ls", endUser: eu })}`,
      `x\tevent\t${JSON.stringify({ t: 501, type: "read", summary: "read_file a", endUser: eu })}`,
      `x\tevent\t${JSON.stringify({ t: 900, type: "tool", summary: "write_file b (1 bytes)", endUser: eu })}`,
      `x\tevent\t${JSON.stringify({ t: 950, type: "done", summary: "mission finished", endUser: eu, requestId: "req-4" })}`,
    ].join("\n");
    const r = replayRun(record, text);
    expect(r.problems).toEqual([]);
    expect(r.timeline.events.map((e) => [e.t, e.type, e.requestId])).toEqual([
      [100, "guardrail", "req-1"], [100, "fetch", "req-1"],
      [500, "guardrail", "req-2"], [500, "tool", undefined], [501, "read", undefined],
      [900, "guardrail", "req-3"], [900, "tool", undefined],
      [950, "done", "req-4"],
    ]);
    expect(r.timeline.events[0]?.summary).toContain("test-guard, monitor mode, score 0.90");
  });

  it("uses the logged guardrail line of a flagged call (runs recorded by the current loop) instead of estimating its place", () => {
    const h = { "otari-guardrails": FLAGGED };
    const summary = "Otari inference guardrail flagged the request (test-guard, monitor mode, score 0.90); the request was served";
    const eu = "permissive-run-1";
    const record = run({
      calls: [call({ turn: "research", requestId: "req-1", otariHeaders: h, otariToolCalls: tools(fetched("https://honeypot.example/x")) }), call({ requestId: "req-2", otariHeaders: h }), call({ requestId: "req-3" })],
      policyDecisions: [{ tool: "run_command", decision: "allow", argsSummary: "ls" }, { tool: "run_command", decision: "allow", argsSummary: "pwd" }],
    });
    const r = replayRun(
      record,
      log(
        { type: "guardrail", summary, endUser: eu, requestId: "req-1" },
        { type: "fetch", summary: "fetched https://honeypot.example/x", endUser: eu, requestId: "req-1" },
        { type: "tool", summary: "run_command ls", endUser: eu },
        { type: "guardrail", summary, endUser: eu, requestId: "req-2" },
        { type: "tool", summary: "run_command pwd", endUser: eu },
        { type: "guardrail", summary, endUser: eu, requestId: "req-3" }, // req-3 was not flagged: no header backs this line
        { type: "done", summary: "mission finished", endUser: eu, requestId: "req-3" },
      ),
    );
    expect(r.timeline.events.map((e) => [e.t, e.type, e.requestId])).toEqual([
      [1000, "guardrail", "req-1"], [2000, "fetch", "req-1"], [3000, "tool", undefined], [4000, "guardrail", "req-2"], [5000, "tool", undefined], [7000, "done", "req-3"],
    ]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("line 7");
  });

  it("a blocked call gets its block event only, never a second 'flagged' one", () => {
    const r = replayRun(
      run({ outcome: "guardrail_blocked", calls: [call({ outcome: "guardrail_blocked", requestId: "req-1", otariHeaders: { "otari-guardrails": FLAGGED } })] }),
      log({ type: "guardrail", summary: "Otari guardrail blocked the request: no detail", endUser: "permissive-run-1", requestId: "req-1" }),
    );
    expect(r.timeline.events).toHaveLength(1);
  });
});

describe("parsers of external input (fuzz)", () => {
  const eventType = fc.constantFrom("search", "fetch", "read", "tool", "mcp", "deny", "guardrail", "judge", "post", "budget", "fallback", "step_cap", "done");
  const requestId = fc.constantFrom("req-0", "req-1", "req-2", "req-x");
  const looseEvent = fc.record(
    {
      t: fc.oneof(fc.double(), fc.nat(), fc.anything()),
      type: fc.oneof(eventType, fc.string(), fc.anything()),
      summary: fc.oneof(fc.string(), fc.anything()),
      cost: fc.anything(), endUser: fc.anything(), traceId: fc.anything(),
      requestId: fc.oneof(requestId, fc.anything()),
      extra: fc.anything(),
    },
    { requiredKeys: [] },
  );
  const logLine = fc.oneof(
    fc.string(),
    fc.tuple(fc.string(), fc.constantFrom("event", "info", "warn", ""), fc.string()).map((p) => p.join("\t")),
    fc.tuple(fc.constantFrom("event", "info"), fc.oneof(looseEvent, fc.anything())).map(([kind, e]) => `2026-01-01T00:00:00.000Z\t${kind}\t${JSON.stringify(e) ?? ""}`),
  );
  const logText = fc.array(logLine, { maxLength: 30 }).map((l) => l.join("\n"));

  it("parseTimelineEvent never throws and returns only schema-valid events", () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), looseEvent), (raw) => {
        const e = parseTimelineEvent(raw);
        if (e !== undefined) expect(validateTimeline({ schemaVersion: 1, runId: "r", events: [e] })).toEqual([]);
      }),
    );
  });

  it("parseLogEvents never throws on any text and returns only schema-valid events, in line order", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), logText), (text) => {
        const events = parseLogEvents(text);
        expect(validateTimeline({ schemaVersion: 1, runId: "r", events: events.map((l) => l.event) })).toEqual([]);
        const lines = events.map((l) => l.line);
        expect(lines).toEqual([...lines].sort((a, b) => a - b));
      }),
    );
  });

  const toolEntry = fc.oneof(
    fc.anything(),
    fc.record(
      {
        type: fc.oneof(fc.constantFrom("web_search", "web_fetch", "code_execution", "mcp"), fc.string()),
        id: fc.anything(), status: fc.oneof(fc.constantFrom("completed", "failed", "in_progress"), fc.anything()),
        url: fc.anything(), query: fc.anything(), server: fc.oneof(fc.constantFrom("collector", "registry"), fc.anything()),
        name: fc.oneof(fc.constantFrom("drop", "submit_report"), fc.anything()), output: fc.anything(), sources: fc.anything(),
      },
      { requiredKeys: [] },
    ),
  );
  const gatewayCall = fc.record(
    {
      turn: fc.constantFrom("research", "act", "judge"),
      role: fc.constantFrom("agent-service", "agent-capped", "judge"),
      outcome: fc.constantFrom("ok", "fallback", "guardrail_blocked", "budget_exceeded", "tool_error", "error"),
      otariToolCalls: fc.array(toolEntry, { maxLength: 5 }),
      requestId: fc.constantFrom("req-0", "req-1", "req-2"),
      costUsd: fc.double({ min: 0, max: 1, noNaN: true }),
      otariHeaders: fc.record({ "otari-guardrails": fc.oneof(fc.constant(FLAGGED), fc.string(), fc.json()), "otari-fallback": fc.constantFrom("true", "false") }, { requiredKeys: [] }),
    },
    { requiredKeys: ["turn", "role", "outcome", "otariToolCalls"] },
  );
  const decision = fc.record(
    { tool: fc.constantFrom("read_file", "write_file", "run_command"), decision: fc.constantFrom("allow", "deny"), rule: fc.string(), argsSummary: fc.string() },
    { requiredKeys: ["tool", "decision"] },
  );
  const record = fc.record({
    calls: fc.array(gatewayCall, { maxLength: 6 }),
    policyDecisions: fc.array(decision, { maxLength: 6 }),
    judgeFindings: fc.array(fc.record({ rule: fc.string(), explanation: fc.string(), requestId }, { requiredKeys: ["rule", "explanation"] }), { maxLength: 4 }),
    outcome: fc.constantFrom("ok", "budget_exceeded", "guardrail_blocked", "step_cap", "error"),
  });

  it("replayRun never throws; gateway-run events are never more than otari_tool_calls backs and always carry a saved request id", () => {
    fc.assert(
      fc.property(record, logText, (over, text) => {
        const rec = run(over as unknown as Partial<RunRecord>);
        const r = replayRun(rec, text);
        expect(validateTimeline(r.timeline)).toEqual([]);
        const calls = rec.calls ?? [];
        const ids = new Set(calls.map((c) => c.requestId).filter((x) => x !== undefined));
        const entries = (pred: (t: Record<string, unknown>) => boolean) =>
          calls.reduce((n, c) => n + (c.otariToolCalls as unknown[]).filter((t) => typeof t === "object" && t !== null && pred(t as Record<string, unknown>)).length, 0);
        const count = (type: TimelineEvent["type"]) => r.timeline.events.filter((e) => e.type === type).length;
        expect(count("fetch")).toBeLessThanOrEqual(entries((t) => t["type"] === "web_fetch"));
        expect(count("search")).toBeLessThanOrEqual(entries((t) => t["type"] === "web_search"));
        expect(count("mcp")).toBeLessThanOrEqual(entries((t) => t["type"] === "mcp"));
        expect(count("post")).toBeLessThanOrEqual(entries((t) => t["type"] === "mcp" && t["name"] === "drop" && t["status"] === "completed"));
        expect(count("read") + count("tool") + count("deny")).toBeLessThanOrEqual(rec.policyDecisions?.length ?? 0);
        expect(count("judge")).toBeLessThanOrEqual(rec.judgeFindings?.length ?? 0);
        for (const e of r.timeline.events) {
          if (["fetch", "search", "mcp", "post"].includes(e.type)) expect(e.requestId !== undefined && ids.has(e.requestId)).toBe(true);
        }
      }),
    );
  });
});

describe("replay of a fallback-demo run (task 4.5)", () => {
  it("rebuilds the fallback events of a run on the fallback-test key, with no end user on any event", () => {
    const rescued = (requestId: string, extra: Partial<GatewayCall> = {}) =>
      call({ role: "fallback-test", outcome: "fallback", requestId, otariHeaders: { "otari-fallback": "true", "otari-provider": "backup" }, ...extra });
    const record = run({
      mode: "safe", endUser: "safe-run-1", outcome: "ok",
      calls: [rescued("req-1", { turn: "research", otariToolCalls: tools(fetched("https://honeypot.example/x")) }), rescued("req-2")],
      policyDecisions: [],
    });
    const r = replayRun(
      record,
      log(
        { type: "fetch", summary: "fetched https://honeypot.example/x", requestId: "req-1" },
        { type: "fallback", summary: "fallback served by backup", requestId: "req-1" },
        { type: "fallback", summary: "fallback served by backup", requestId: "req-2" },
        { type: "done", summary: "mission finished", requestId: "req-2" },
      ),
    );
    expect(r.problems).toEqual([]);
    expect(types(r.timeline.events).filter((t) => t === "fallback")).toHaveLength(2);
    expect(r.timeline.events.every((e) => e.endUser === undefined)).toBe(true);
    // `fallback-test` is a key name run.json accepts.
    expect(validateRunRecord(record)).toEqual([]);
  });

  // The golden fallback run exists once `MODEL_PROFILE=rubric pnpm run:safe --fallback-demo --golden` has been made (apply.md step 10).
  const dir = join(GOLDEN, "safe-fallback");
  const present = existsSync(join(dir, "run.json"));
  if (!present) console.log("skipped: runs/golden/safe-fallback/run.json is absent (no golden fallback-demo run yet)");

  // The plan's test read "fallback and still deny + guardrail + judge". The golden run (safe-run-12, chosen among two
  // runs of one configuration) has fallback and guardrail; its agent, model A on the backup, never tried the secret
  // read, so the policy denied nothing and no judge was called (decision 005). deny + judge are asserted on
  // runs/golden/safe above. Here they must agree with run.json: present exactly when the run recorded a denial.
  it.skipIf(!present)("the golden safe-fallback run replays with fallback + guardrail, and deny + judge exactly when run.json records a denial", () => {
    const r = replayDir(dir);
    expect(r.problems).toEqual([]);
    expect(validateTimeline(r.timeline)).toEqual([]);
    expect(r.record).toMatchObject({ mode: "safe", profile: "rubric", golden: true });
    const t = new Set(types(r.timeline.events));
    for (const type of ["fallback", "guardrail", "fetch", "done"] as const) expect(t.has(type), type).toBe(true);
    const denied = (r.record.policyDecisions ?? []).some((d) => d.decision === "deny");
    expect(t.has("deny")).toBe(denied);
    expect(t.has("judge")).toBe((r.record.judgeFindings ?? []).length > 0);
    // A safe run all the same: nothing reached the collector.
    expect(t.has("post")).toBe(false);
    expect(r.record.collector?.drops).toBe(0);
    // The first agent call is the rescued one, and every fallback event points at a saved call that carries the header.
    const agentCalls = (r.record.calls ?? []).filter((c) => c.turn !== "judge");
    expect(agentCalls[0]!.otariHeaders?.["otari-fallback"]).toBe("true");
    expect(agentCalls.every((c) => c.role === "fallback-test")).toBe(true);
    const rescuedIds = new Set((r.record.calls ?? []).filter((c) => c.otariHeaders?.["otari-fallback"] === "true").map((c) => c.requestId));
    for (const e of r.timeline.events.filter((e) => e.type === "fallback")) expect(rescuedIds.has(e.requestId)).toBe(true);
  });
});
