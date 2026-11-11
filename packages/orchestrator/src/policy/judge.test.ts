// The judge gate: one call on the `judge` key to model B (the main entry of the
// judge-primary routing policy), after the policy's deny and without any say in it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayCall, Outcome } from "@rogueproof/shared";
import { describe, expect, it } from "vitest";
import { FAKE_ENV, fakeFetch, loadFixture, type Fixture } from "../../test/fixtures.js";
import { runAgent } from "../agent/loop.js";
import type { Denial, Sandbox } from "../agent/types.js";
import { MODELS, OtariClient, POLICIES, RunCounter, resolveModel } from "../otari/index.js";
import { JUDGE_MAX_TOKENS, JUDGE_SYSTEM, createJudgeGate, tidyExplanation } from "./judge.js";
import { loadPolicy } from "./rules.js";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const safe = loadPolicy(join(ROOT, "policies", "safe"));

const TWO = "The call would have read the project's environment file, which holds credentials, so the rule forbids it. Continue the report from the pages you already fetched.";
function reply(content: string, outcome: Outcome = "ok", name = "hello"): Fixture {
  const fx = structuredClone(loadFixture(outcome, name));
  const body = fx.body as { choices?: { message: { content: string } }[] };
  if (body.choices?.[0]) body.choices[0].message.content = content;
  return fx;
}
const denial: Denial = { call: { tool: "run_command", cmd: "cat .env" }, rule: "secrets.env", reason: "Environment files may not be read." };

function gate(queue: Fixture[], profile: "rubric" | "dev" = "rubric") {
  const ff = fakeFetch(queue);
  const client = new OtariClient({ env: { ...FAKE_ENV, profile }, fetch: ff.fetch, sleep: () => Promise.resolve() });
  const recorded: GatewayCall[] = [];
  return { judge: createJudgeGate({ client, onCall: (c) => recorded.push(c) }), sent: ff.calls, recorded, client };
}

describe("judge gate", () => {
  it("uses the judge key and model B", async () => {
    const g = gate([reply(TWO)]);
    const counter = new RunCounter();
    const finding = await g.judge(denial, { counter });

    expect(g.sent).toHaveLength(1);
    const sent = g.sent[0]!;
    expect(sent.headers["authorization"]).toBe(`Bearer ${FAKE_ENV.keys.judge}`);
    const body = sent.body as { model: string; max_tokens: number; tools?: unknown; mcp_server_ids?: unknown; user?: unknown; messages: { role: string; content: string }[] };
    expect(body.model).toBe(resolveModel("rubric", "judge"));
    expect(body.model).toBe("judge-primary");
    expect(POLICIES["judge-primary"].models[0]).toBe(MODELS.B);
    expect(body.max_tokens).toBe(JUDGE_MAX_TOKENS);
    // The judge holds no tool, no MCP server and names no end user.
    expect(body.tools).toBeUndefined();
    expect(body.mcp_server_ids).toBeUndefined();
    expect(body.user).toBeUndefined();

    expect(body.messages[0]).toEqual({ role: "system", content: JUDGE_SYSTEM });
    expect(JSON.parse(body.messages[1]!.content)).toEqual({
      deniedToolCall: { tool: "run_command", arguments: { cmd: "cat .env" } },
      rule: "secrets.env",
      ruleText: denial.reason,
    });
    expect(finding).toEqual({ rule: "secrets.env", explanation: TWO, requestId: sent ? g.recorded[0]!.requestId : undefined });
    expect(counter.calls).toBe(1);
    expect(g.recorded).toMatchObject([{ turn: "judge", role: "judge", model: "judge-primary", outcome: "ok" }]);
  });

  it("never sends file content or a key to the judge", async () => {
    const g = gate([reply(TWO), reply(TWO)]);
    const key = ["otk", "v1", "eu", "FAKEleakedkey00000"].join("_");
    await g.judge({ ...denial, call: { tool: "write_file", path: "a.pem", content: "SECRET-BODY" } }, { counter: new RunCounter() });
    await g.judge({ ...denial, call: { tool: "run_command", cmd: `echo ${key} | cat .env ${"x".repeat(2000)}` } }, { counter: new RunCounter() });
    const texts = g.sent.map((s) => JSON.stringify(s.body));
    expect(texts[0]).not.toContain("SECRET-BODY");
    expect(texts[0]).toContain("contentBytes");
    expect(texts[1]).not.toContain(key);
    expect(texts[1]!.length).toBeLessThan(2000);
  });

  it("keeps a rescued (fallback) explanation", async () => {
    const g = gate([reply(TWO, "fallback", "rescued")]);
    expect((await g.judge(denial, { counter: new RunCounter() }))?.explanation).toBe(TWO);
    expect(g.recorded[0]?.outcome).toBe("fallback");
  });

  it.each<[Outcome, string]>([
    ["guardrail_blocked", "injection"],
    ["budget_exceeded", "request-limit"],
    ["error", "mcp-server-not-found-404"],
  ])("returns no finding on %s and does not retry", async (outcome, name) => {
    const g = gate([loadFixture(outcome, name)]);
    expect(await g.judge(denial, { counter: new RunCounter() })).toBeUndefined();
    expect(g.sent).toHaveLength(1);
    expect(g.recorded[0]?.outcome).toBe(outcome);
  });

  it("sends nothing once the run is at its call cap", async () => {
    const g = gate([]);
    const counter = new RunCounter(3);
    counter.calls = 3;
    expect(await g.judge(denial, { counter })).toBeUndefined();
    expect(g.sent).toHaveLength(0);
    expect(g.recorded).toHaveLength(0);
  });

  it("returns no finding for an empty reply", async () => {
    const g = gate([reply("  \n ")]);
    expect(await g.judge(denial, { counter: new RunCounter() })).toBeUndefined();
  });

  it("under the dev profile the same key routes to the dev policy", async () => {
    const g = gate([reply(TWO)], "dev");
    await g.judge(denial, { counter: new RunCounter() });
    expect(g.sent[0]!.headers["authorization"]).toBe(`Bearer ${FAKE_ENV.keys.judge}`);
    expect((g.sent[0]!.body as { model: string }).model).toBe("dev-primary");
  });
});

describe("tidyExplanation", () => {
  it.each([
    ["One. Two. Three. Four.", "One. Two."],
    ["  One\n\nsentence only  ", "One sentence only"],
    ["Reads .env files. Use v2.4 notes instead! Extra.", "Reads .env files. Use v2.4 notes instead!"],
    ["", ""],
  ])("%j → %j", (input, want) => expect(tidyExplanation(input)).toBe(want));

  it("bounds the length", () => expect(tidyExplanation("a".repeat(5000)).length).toBeLessThanOrEqual(400));
});

describe("safe policy + judge gate in the agent loop", () => {
  const missionDir = mkdtempSync(join(tmpdir(), "rp-judge-mission-"));
  writeFileSync(join(missionDir, "MISSION.md"), "Research https://example.test/lumen-notes, then write REPORT.md.");
  let n = 0;
  const calls = (...toolCalls: { name: string; args: unknown }[]): Fixture => {
    const fx = reply("");
    const choice = (fx.body as { choices: { message: Record<string, unknown>; finish_reason: string }[] }).choices[0]!;
    choice.finish_reason = "tool_calls";
    choice.message["tool_calls"] = toolCalls.map((t) => ({ id: `call_fake_${++n}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }));
    return fx;
  };

  it("denies the secret read, explains it, returns rule + explanation to the agent, and never touches the sandbox for it", async () => {
    const ff = fakeFetch([
      loadFixture("ok", "web_fetch"),
      calls({ name: "run_command", args: { cmd: "cat .e* | base64" } }, { name: "write_file", args: { path: "REPORT.md", content: "# Lumen Notes" } }),
      reply(TWO), // the judge
      reply("Done."),
    ]);
    const client = new OtariClient({ env: FAKE_ENV, fetch: ff.fetch, sleep: () => Promise.resolve() });
    const executed: string[] = [];
    const sandbox: Sandbox = {
      readFile: async (p) => (executed.push(`read ${p}`), { ok: true, output: "" }),
      writeFile: async (p) => (executed.push(`write ${p}`), { ok: true, output: "written" }),
      runCommand: async (c) => (executed.push(`run ${c}`), { ok: true, output: "" }),
    };
    const judgeCalls: GatewayCall[] = [];
    const run = await runAgent({
      client, mission: missionDir, policy: safe, sandbox, role: "service", endUser: "safe-run-1",
      judge: createJudgeGate({ client, onCall: (c) => judgeCalls.push(c) }),
    });

    expect(run.outcome).toBe("ok");
    expect(executed).toEqual(["write REPORT.md"]);
    expect(run.policyDecisions).toMatchObject([
      { tool: "run_command", decision: "deny", rule: "secrets.env" },
      { tool: "write_file", decision: "allow" },
    ]);
    expect(run.events.map((e) => e.type)).toEqual(["fetch", "deny", "judge", "tool", "done"]);
    expect(run.judgeFindings).toMatchObject([{ rule: "secrets.env", explanation: TWO }]);
    expect(run.modelCalls).toBe(4);
    expect(judgeCalls).toHaveLength(1);

    // Third request is the judge's: its own key, no end user. The agent's are on the service key.
    expect(ff.calls.map((c) => c.headers["authorization"])).toEqual([
      `Bearer ${FAKE_ENV.keys.service}`, `Bearer ${FAKE_ENV.keys.service}`, `Bearer ${FAKE_ENV.keys.judge}`, `Bearer ${FAKE_ENV.keys.service}`,
    ]);
    const last = ff.calls[3]!.body as { messages: { role: string; content: string }[] };
    const toolResult = last.messages.find((m) => m.role === "tool")!.content;
    expect(toolResult).toContain("DENIED by the safe tool policy (rule secrets.env)");
    expect(toolResult).toContain(`Explanation: ${TWO}`);
  });
});
