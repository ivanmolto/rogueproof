import { OUTCOMES } from "@rogueproof/shared";
import { describe, expect, it } from "vitest";
import { FAKE_ENV, fakeFetch, listFixtures, loadFixture } from "../../test/fixtures.js";
import { END_USER_FIELD, OtariClient, RunCounter } from "./client.js";
import { ToolSetError } from "./tools.js";

const hello = [{ role: "user" as const, content: "hello" }];
const noSleep = () => Promise.resolve();
const make = (fixtures: ReturnType<typeof loadFixture>[]) => {
  const ff = fakeFetch(fixtures);
  return { client: new OtariClient({ env: FAKE_ENV, fetch: ff.fetch, sleep: noSleep }), calls: ff.calls };
};

describe("fixtures", () => {
  it("every outcome has at least one fixture directory with a file", () => {
    const list = listFixtures();
    for (const o of OUTCOMES) expect(list[o].length, o).toBeGreaterThan(0);
  });
});

describe("OtariClient.chat outcomes", () => {
  it("ok: plain completion with usage, cost and empty otariToolCalls", async () => {
    const { client, calls } = make([loadFixture("ok", "hello")]);
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("ok");
    expect(r.fallback).toBe(false);
    expect(r.otariToolCalls).toEqual([]);
    expect(r.usage).toEqual({ promptTokens: 12, completionTokens: 7, totalTokens: 19 });
    expect(r.cost).toBeCloseTo(0.00001, 8);
    expect(r.requestId).toBe("req_fake_0001");
    expect(r.headers["otari-provider"]).toBe("fakeprov");
    expect(r.status).toBe(200);
    expect(r.attempts).toBe(1);
    expect(calls[0]!.url).toBe("https://fake.gateway.test/api/v1/chat/completions");
    expect(calls[0]!.headers["authorization"]).toMatch(/^Bearer /);
  });

  it.each([
    ["web_fetch", "web_fetch", { url: "https://example.test/lumen-notes/changelog" }],
    ["web_search", "web_search", { query: "lumen notes changelog" }],
    ["mcp", "mcp", { server: "collector", name: "drop" }],
    ["code_execution", "code_execution", { stdout: "3\n", exit_code: 0 }],
  ] as const)("ok: otari_tool_calls of kind %s are typed", async (fixture, type, fields) => {
    const { client } = make([loadFixture("ok", fixture)]);
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("ok");
    expect(r.otariToolCalls).toHaveLength(1);
    expect(r.otariToolCalls[0]).toMatchObject({ type, status: "completed", ...fields });
  });

  it("fallback: Otari-Fallback: true", async () => {
    const { client } = make([loadFixture("fallback", "rescued")]);
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("fallback");
    expect(r.fallback).toBe(true);
    expect(r.headers["otari-attempt-count"]).toBe("2");
    expect(r.response?.choices[0]?.message.content).toContain("fallback");
  });

  it("guardrail_blocked: 403 guardrail_violation, never retried", async () => {
    const { client, calls } = make([loadFixture("guardrail_blocked", "injection"), loadFixture("ok", "hello")]);
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("guardrail_blocked");
    expect(r.error?.code).toBe("guardrail_violation");
    expect(r.headers["otari-guardrails"]).toContain("fake-injection");
    expect(calls).toHaveLength(1);
  });

  it.each(["key-budget", "request-limit", "end-user"])("budget_exceeded: %s, never retried", async (name) => {
    const { client, calls } = make([loadFixture("budget_exceeded", name), loadFixture("ok", "hello")]);
    const r = await client.chat("capped", hello);
    expect(r.outcome).toBe("budget_exceeded");
    expect(r.error?.code).toBe("budget_exceeded");
    expect(calls).toHaveLength(1);
  });

  it("guardrail_blocked: the live shape (code nested under body.detail, no Otari-Error-Code header) is recognised and never retried", async () => {
    const { client, calls } = make([loadFixture("guardrail_blocked", "injection-live-shape"), loadFixture("ok", "hello")]);
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("guardrail_blocked");
    expect(r.status).toBe(403);
    expect(r.error?.code).toBe("guardrail_violation");
    expect(r.error?.detail).toContain("fake-injection");
    expect(r.headers["otari-error-code"]).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it.each(["fetch-failed", "call-limit"])("tool_error: %s is a 200 with a failed otari_tool_calls entry", async (name) => {
    const { client } = make([loadFixture("tool_error", name)]);
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("tool_error");
    expect(r.status).toBe(200);
    expect(r.otariToolCalls[0]?.status).toBe("failed");
    expect(r.otariToolCalls[0]?.error).toBeDefined();
  });

  it("error: the gateway's MCP tool-name conflict with a built-in is a 400 and is not retried", async () => {
    const { client, calls } = make([loadFixture("error", "web-plus-mcp-refused"), loadFixture("ok", "hello")]);
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("error");
    expect(r.error?.detail).toMatch(/web_fetch/);
    expect(calls).toHaveLength(1);
  });

  it("error: MCP refusals seen live (unknown server id 404, inline URL 400) carry only {detail} and are not retried", async () => {
    for (const name of ["mcp-server-not-found-404", "mcp-inline-not-allowed-400"]) {
      const { client, calls } = make([loadFixture("error", name), loadFixture("ok", "hello")]);
      const r = await client.chat("agent", hello);
      expect(r.outcome).toBe("error");
      expect(r.error?.detail).toMatch(/MCP server/);
      expect(calls).toHaveLength(1);
    }
  });

  it("error: 424 provider_not_configured is not retried", async () => {
    const { client, calls } = make([loadFixture("error", "provider-not-configured-424"), loadFixture("ok", "hello")]);
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("error");
    expect(calls).toHaveLength(1);
  });

  it("error: retryable 502 then 429 are retried, bounded, and the third answer wins", async () => {
    const { client, calls } = make([loadFixture("error", "provider-502"), loadFixture("error", "rate-limited-429"), loadFixture("ok", "hello")]);
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("ok");
    expect(r.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(client.recorder.records.filter((x) => x.outcome === "error")).toHaveLength(2);
  });

  it("error: retries stop after the bound and report error", async () => {
    const { client, calls } = make([loadFixture("error", "provider-502"), loadFixture("error", "provider-502"), loadFixture("error", "provider-502"), loadFixture("ok", "hello")]);
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("error");
    expect(r.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("error: a transport failure is classified, not thrown", async () => {
    const ff = fakeFetch([]);
    const client = new OtariClient({ env: FAKE_ENV, fetch: ff.fetch, sleep: noSleep });
    const r = await client.chat("agent", hello);
    expect(r.outcome).toBe("error");
    expect(r.error?.code).toBe("transport");
    expect(r.status).toBeUndefined();
  });

  it("step_cap: call 41 of a run is refused before sending", async () => {
    const { client, calls } = make([loadFixture("ok", "hello")]);
    const counter = new RunCounter(1);
    const first = await client.chat("agent", hello, { counter });
    expect(first.outcome).toBe("ok");
    const second = await client.chat("agent", hello, { counter });
    expect(second.outcome).toBe("step_cap");
    expect(calls).toHaveLength(1);
    expect(counter.calls).toBe(1);
  });

  it("every outcome in the enum is produced by some test above", () => {
    expect([...OUTCOMES].sort()).toEqual(["budget_exceeded", "error", "fallback", "guardrail_blocked", "ok", "step_cap", "tool_error"]);
  });
});

describe("OtariClient.buildRequest", () => {
  const { client } = make([]);

  it("sets max_tokens on every call, sends temperature only when asked, and resolves the model from the profile", () => {
    const req = client.buildRequest("judge", hello);
    expect(req.max_tokens).toBe(1024);
    expect(req.temperature).toBeUndefined();
    expect(client.buildRequest("judge", hello, { temperature: 0 }).temperature).toBe(0);
    expect(req.model).toBe("judge-primary");
    expect(client.buildRequest("agent", hello).model).toBe("agent-primary");
    expect(client.buildRequest("agent", hello, { model: "x:y/z" }).model).toBe("x:y/z");
  });

  it("names the end user in the documented field, on the service role only", () => {
    expect(END_USER_FIELD).toBe("user");
    const req = client.buildRequest("service", hello, { endUser: "smoke-user-1" }) as unknown as Record<string, unknown>;
    expect(req["user"]).toBe("smoke-user-1");
    expect(() => client.buildRequest("agent", hello, { endUser: "x" })).toThrow(/service role/);
  });

  it("a research turn never carries mcp_server_ids or otari_code_execution", () => {
    expect(() => client.buildRequest("agent", hello, { tools: [{ type: "otari_web_fetch" }], mcpServerIds: ["m1"] })).toThrow(ToolSetError);
    expect(() => client.buildRequest("agent", hello, { tools: [{ type: "otari_web_search" }, { type: "otari_code_execution" }] })).toThrow(ToolSetError);
  });

  it("an act turn carries function tools plus mcp_server_ids and no web tool", () => {
    const fn = { type: "function" as const, function: { name: "read_file", parameters: { type: "object" } } };
    const req = client.buildRequest("agent", hello, { tools: [fn], mcpServerIds: ["m1"] }) as unknown as Record<string, unknown>;
    expect(req["mcp_server_ids"]).toEqual(["m1"]);
    expect(req["tools"]).toEqual([fn]);
  });

  it("a report call carries otari_code_execution only", () => {
    const req = client.buildRequest("report", hello, { tools: [{ type: "otari_code_execution" }] }) as unknown as Record<string, unknown>;
    expect(req["tools"]).toEqual([{ type: "otari_code_execution" }]);
    expect(req["mcp_server_ids"]).toBeUndefined();
  });
});

describe("records", () => {
  it("contain no key-shaped strings or bearer tokens", async () => {
    const { client } = make([loadFixture("ok", "hello"), loadFixture("guardrail_blocked", "injection")]);
    await client.chat("agent", [{ role: "user", content: `my key is ${FAKE_ENV.keys.agent} and token Bearer abcdefghijklmnop` }]);
    await client.chat("judge", hello);
    const text = JSON.stringify(client.recorder.records);
    expect(text).not.toMatch(/\botk_v1_/);
    expect(text).not.toMatch(/\btk-[A-Za-z0-9_-]{6,}/);
    expect(text).not.toMatch(/\bgw_[A-Za-z0-9_-]{6,}/);
    expect(text).not.toMatch(/bearer\s+[A-Za-z0-9]{8,}/i);
    expect(text).toContain("[REDACTED]");
    expect(client.recorder.records).toHaveLength(2);
    expect(client.recorder.records[1]?.outcome).toBe("guardrail_blocked");
  });
});
