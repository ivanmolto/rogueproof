import { describeOtari } from "@rogueproof/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FAKE_ENV, fakeFetch, loadTelemetryFixture as fx, type Fixture } from "../../test/fixtures.js";
import { OtariClient } from "./client.js";
import { loadDotEnv, readOtariEnv } from "./env.js";
import { OtariTelemetry, parseEndUser, parseKeyBudget, parseKeyUsage, parseRequestUsage, parseTraceList, reasonFor } from "./telemetry.js";

const since = new Date("2026-01-01T00:00:00Z");
const until = new Date("2026-01-01T01:00:00Z");
const make = (queue: Fixture[]) => {
  const ff = fakeFetch(queue);
  return { t: new OtariTelemetry({ env: FAKE_ENV, fetch: ff.fetch }), calls: ff.calls };
};
const SECRETS = /otk_v1_|\btk-|\bgw_|Bearer\s|otari-key/i;

describe("getUsage", () => {
  it("available: sums the per-key summaries and keeps the breakdowns", async () => {
    const { t, calls } = make([fx("key-usage-summary"), fx("key-usage-summary")]);
    const r = await t.getUsage(since, { until, roles: ["agent", "service"] });
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.scope).toBe("keys");
    expect(r.totals).toEqual({ cost: 0.0025, requests: 8, errors: 2, promptTokens: 600, completionTokens: 200, totalTokens: 800 });
    expect(r.byRole.agent?.byModel.map((g) => g.key)).toEqual(["fake/model-a", "fake/model-b"]);
    expect(r.byRole.service?.byUser[0]).toMatchObject({ label: "fake-run-1", cost: 0.00075, requests: 2 });
    expect(calls).toHaveLength(2);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/key/usage/summary");
    expect(url.searchParams.get("start_date")).toBe(since.toISOString());
    expect(url.searchParams.get("end_date")).toBe(until.toISOString());
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${FAKE_ENV.keys.agent}`);
    expect(calls[1]!.headers["authorization"]).toBe(`Bearer ${FAKE_ENV.keys.service}`);
  });

  it("defaults to every role key", async () => {
    const { t, calls } = make(Array.from({ length: 5 }, () => fx("key-usage-summary")));
    const r = await t.getUsage(since);
    expect(r.available && Object.keys(r.byRole)).toEqual(["agent", "judge", "report", "capped", "service"]);
    expect(calls).toHaveLength(5);
  });

  it("unavailable: a refusal names the role and is not retried", async () => {
    const { t, calls } = make([fx("key-usage-summary"), fx("master-key-401"), fx("key-usage-summary")]);
    const r = await t.getUsage(since, { roles: ["agent", "judge", "report"] });
    expect(r).toMatchObject({ available: false, status: 401 });
    expect(!r.available && r.reason).toContain('key "judge"');
    expect(calls).toHaveLength(2);
  });

  it("unavailable: a 200 with an unexpected body", async () => {
    const { t } = make([{ status: 200, headers: {}, body: { totals: "nope" } }]);
    const r = await t.getUsage(since, { roles: ["agent"] });
    expect(r).toMatchObject({ available: false, status: 200 });
  });
});

describe("getRequestUsage", () => {
  it("available: settled cost and tokens of one request", async () => {
    const { t, calls } = make([fx("request-settlement")]);
    const r = await t.getRequestUsage("agent", "00000000-0000-4000-8000-000000000001");
    expect(r).toEqual({
      available: true, requestId: "00000000-0000-4000-8000-000000000001", status: "success",
      cost: 0.00001, promptTokens: 12, completionTokens: 7, totalTokens: 19,
    });
    expect(calls[0]!.url).toBe("https://fake.gateway.test/api/v1/usage/requests/00000000-0000-4000-8000-000000000001");
  });

  it("unavailable: 404 for an unknown, unsettled or foreign request id", async () => {
    const { t } = make([fx("request-not-found-404")]);
    const r = await t.getRequestUsage("agent", "x/../y");
    expect(r).toMatchObject({ available: false, status: 404 });
    expect(!r.available && r.reason).toMatch(/not yet settled.*Request not found/);
  });
});

describe("getTraces and getOrganizationUsage", () => {
  it("unavailable on hosted: 401 Invalid master key", async () => {
    const { t, calls } = make([fx("master-key-401"), fx("master-key-401")]);
    const traces = await t.getTraces(since);
    const org = await t.getOrganizationUsage(since);
    for (const r of [traces, org]) {
      expect(r).toMatchObject({ available: false, status: 401 });
      expect(!r.available && r.reason).toMatch(/needs the master key.*HTTP 401: Invalid master key/);
    }
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/traces");
    expect(new URL(calls[1]!.url).pathname).toBe("/api/v1/organizations/me/usage/summary");
  });

  it("available when the gateway answers (self-hosted, or hosted later)", async () => {
    const { t } = make([fx("traces"), fx("key-usage-summary")]);
    const traces = await t.getTraces(since);
    expect(traces).toMatchObject({ available: true, hasMore: false, traces: [{ traceId: "trace_fake_0001", stepCount: 3, cost: 0.001 }] });
    const org = await t.getOrganizationUsage(since);
    expect(org).toMatchObject({ available: true, totals: { cost: 0.00125, requests: 4 } });
  });
});

describe("getEndUserSpend", () => {
  it("available: a number, read with the service key", async () => {
    const { t, calls } = make([fx("end-user")]);
    const r = await t.getEndUserSpend("fake-run-1");
    expect(r).toEqual({
      available: true, endUser: "fake-run-1", spend: 0.00075, reserved: 0, requests: 2, tokens: 250,
      blocked: false, budgetId: "00000000-0000-4000-8000-0000000000b1",
    });
    expect(calls[0]!.url).toBe("https://fake.gateway.test/api/v1/end-users/fake-run-1");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${FAKE_ENV.keys.service}`);
  });

  it("the end-user id is one encoded path segment", async () => {
    const { t, calls } = make([fx("end-user")]);
    await t.getEndUserSpend("a/b?c d");
    expect(calls[0]!.url).toBe("https://fake.gateway.test/api/v1/end-users/a%2Fb%3Fc%20d");
  });

  it.each([
    ["end-user-not-found-404", 404, /not found/],
    ["service-key-403", 403, /needs a service key/],
  ] as const)("unavailable: %s", async (name, status, reason) => {
    const { t } = make([fx(name)]);
    const r = await t.getEndUserSpend("no-such-user");
    expect(r).toMatchObject({ available: false, status });
    expect(!r.available && r.reason).toMatch(reason);
  });
});

describe("getKeyBudget", () => {
  it("available: remaining USD and request limits of the role's own key", async () => {
    const { t, calls } = make([fx("key-budget")]);
    const r = await t.getKeyBudget("capped");
    expect(r).toEqual({
      available: true, enforced: true, remainingUsd: 0.75,
      limits: [{ scope: "api_token", limitUsd: 1, remainingUsd: 0.75, limitRequests: 4, remainingRequests: 1 }],
    });
    expect(calls[0]!.url).toBe("https://fake.gateway.test/api/v1/key/budget");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${FAKE_ENV.keys.capped}`);
  });

  it("unavailable on a refusal or an unexpected body", async () => {
    const { t } = make([fx("master-key-401"), { status: 200, headers: {}, body: { limits: [] } }]);
    expect(await t.getKeyBudget("agent")).toMatchObject({ available: false, status: 401 });
    expect(await t.getKeyBudget("agent")).toMatchObject({ available: false, status: 200 });
  });
});

describe("failures never throw and never leak a key", () => {
  it("transport failure → available:false with no status", async () => {
    const { t } = make([]);
    const r = await t.getEndUserSpend("fake-run-1");
    expect(r).toMatchObject({ available: false, status: undefined });
    expect(!r.available && r.reason).toMatch(/^transport: /);
  });

  it("a non-JSON error body still gives a reason", async () => {
    const f = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
    const r = await new OtariTelemetry({ env: FAKE_ENV, fetch: f }).getTraces(since);
    expect(r).toEqual({ available: false, reason: "HTTP 502", status: 502 });
  });

  it("a key echoed back by the gateway is redacted in reasons and results", async () => {
    const key = FAKE_ENV.keys.agent;
    const { t } = make([
      { status: 401, headers: {}, body: { detail: `bad key ${key} / Bearer abcdefghijklmnop` } },
      { status: 200, headers: {}, body: { items: [{ trace_id: "t1", name: key }], has_more: false } },
    ]);
    const out = JSON.stringify([await t.getTraces(since), await t.getTraces(since)]);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toMatch(SECRETS);
  });

  it("reasonFor handles any detail type", () => {
    expect(reasonFor(422, { detail: [{ msg: "bad date" }] })).toBe('HTTP 422: [{"msg":"bad date"}]');
    expect(reasonFor(500, null)).toBe("HTTP 500");
  });
});

describe("parsers are total over arbitrary JSON (fuzz)", () => {
  it("never throw; numbers they return are finite", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const body = JSON.parse(JSON.stringify(v)) as unknown;
        const u = parseKeyUsage(body);
        if (u) for (const n of Object.values(u.totals)) expect(Number.isFinite(n)).toBe(true);
        const r = parseRequestUsage(body);
        if (r) expect(Number.isFinite(r.cost)).toBe(true);
        const e = parseEndUser(body);
        if (e) expect(Number.isFinite(e.spend)).toBe(true);
        parseTraceList(body);
        const k = parseKeyBudget(body);
        if (k?.remainingUsd !== undefined) expect(Number.isFinite(k.remainingUsd)).toBe(true);
        expect(typeof reasonFor(400, body)).toBe("string");
      }),
    );
  });

  it("fields of the wrong type are rejected or defaulted, not passed through", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        const e = parseEndUser({ external_id: a, spend: b, current_requests: a, blocked: b });
        if (e) {
          expect(typeof e.endUser).toBe("string");
          expect(Number.isFinite(e.spend) && Number.isFinite(e.requests)).toBe(true);
          expect(typeof e.blocked).toBe("boolean");
        }
        const u = parseKeyUsage({ totals: { cost: a, request_count: b }, by_model: [a, b, { cost: a }] });
        if (u) for (const g of u.byModel) expect(Number.isFinite(g.cost) && typeof g.key === "string").toBe(true);
      }),
    );
  });
});

// Live: one hello, then the gateway's own record of it. This is the Usage tab's row for
// that request, read through the API (the tab itself is checked by eye, docs/spikes/telemetry.md).
describeOtari("telemetry against hosted otari.ai", () => {
  loadDotEnv(import.meta.dirname);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("settled usage of one request matches what its response reported", async () => {
    const env = readOtariEnv();
    const sent = await new OtariClient({ env }).chat("agent", [{ role: "user", content: "Reply with the single word: hello" }], { maxTokens: 16 });
    expect(sent.requestId).toBeDefined();
    const t = new OtariTelemetry({ env });
    let settled = await t.getRequestUsage("agent", sent.requestId!);
    for (let i = 0; i < 10 && !settled.available && settled.status === 404; i++) {
      await sleep(1000); // rows are written by a background writer
      settled = await t.getRequestUsage("agent", sent.requestId!);
    }
    console.log(`request ${sent.requestId}: response cost=${sent.cost} tokens=${sent.usage.totalTokens} · settled ${JSON.stringify(settled)}`);
    expect(settled.available).toBe(true);
    if (!settled.available) return;
    expect(settled.cost).toBeCloseTo(sent.cost ?? NaN, 6);
    expect(settled.totalTokens).toBe(sent.usage.totalTokens);
    expect(JSON.stringify(settled)).not.toMatch(SECRETS);
  }, 60_000);

  it("usage is available per key; traces and organization usage answer either way", async () => {
    const t = new OtariTelemetry({ env: readOtariEnv() });
    const hourAgo = new Date(Date.now() - 3600e3);
    const usage = await t.getUsage(hourAgo);
    expect(usage.available).toBe(true);
    for (const r of [await t.getTraces(hourAgo), await t.getOrganizationUsage(hourAgo)]) {
      if (!r.available) expect(r.reason.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("end-user spend is a number or available:false", async () => {
    const r = await new OtariTelemetry({ env: readOtariEnv() }).getEndUserSpend("smoke-user-1");
    if (r.available) expect(Number.isFinite(r.spend)).toBe(true);
    else expect(r.reason.length).toBeGreaterThan(0);
  }, 30_000);
});
