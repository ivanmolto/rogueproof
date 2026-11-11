import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_ENV, fakeFetch, loadTelemetryFixture, type Fixture } from "../../test/fixtures.js";
import { OtariTelemetry } from "../otari/index.js";
import { BUDGET_DOCS, budgetResetReport, readBudgetPatchDoc } from "./budgetReset.js";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const SECRETS = /otk_v1_|\btk-|\bgw_|Bearer\s|otari-key/i;

function keyBudget(limit: number | null, remaining: number | null): Fixture {
  const fx = structuredClone(loadTelemetryFixture("key-budget"));
  const l = (fx.body as { limits: Record<string, number | null>[] }).limits[0]!;
  l["limit_requests"] = limit;
  l["remaining_requests"] = remaining;
  return fx;
}
const read = async (fx: Fixture) => {
  const f = fakeFetch([fx]);
  const budget = await new OtariTelemetry({ env: FAKE_ENV, fetch: f.fetch }).getKeyBudget("capped");
  return { budget, calls: f.calls };
};

describe("otari-config/budgets: the two documented PATCHes", () => {
  it("request-limit.json sets request_limit 4 and reset.json sets it to null, on the same budget", () => {
    const set = readBudgetPatchDoc(REPO, BUDGET_DOCS.set);
    const reset = readBudgetPatchDoc(REPO, BUDGET_DOCS.reset);
    expect(set.apply.body).toEqual({ request_limit: 4 });
    expect(reset.apply.body).toEqual({ request_limit: null });
    for (const d of [set, reset]) {
      expect(d.key).toBe("agent-capped");
      expect(d.find).toEqual({ method: "GET", path: "/api/v1/organizations/me/budgets" });
      expect(d.apply.path.startsWith("/api/v1/organizations/me/budgets/")).toBe(true);
    }
    expect(set.apply.path).toBe(reset.apply.path);
  });

  it("rejects a document that is not a request_limit PATCH", () => {
    const dir = mkdtempSync(join(tmpdir(), "rogueproof-budgets-"));
    const good = readBudgetPatchDoc(REPO, BUDGET_DOCS.reset);
    for (const bad of [
      {}, [], { ...good, apply: { ...good.apply, method: "DELETE" } }, { ...good, apply: { ...good.apply, body: { request_limit: 0 } } },
      { ...good, apply: { ...good.apply, body: { request_limit: null, budget: 100 } } }, { ...good, key: 7 },
    ]) {
      writeFileSync(join(dir, "doc.json"), JSON.stringify(bad));
      expect(() => readBudgetPatchDoc(dir, "doc.json")).toThrow(/not a budget PATCH document/);
    }
  });
});

describe("pnpm budget:reset", () => {
  const doc = readBudgetPatchDoc(REPO, BUDGET_DOCS.reset);

  it("prints the documented PATCH and verifies the limit is gone with one GET /key/budget on the capped key", async () => {
    const { budget, calls } = await read(keyBudget(null, null));
    const r = budgetResetReport(doc, budget);
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain('PATCH /api/v1/organizations/me/budgets/<id of the agent-capped budget>   body {"request_limit":null}');
    expect(r.lines.at(-1)).toMatch(/^verified: .* reads no request limit/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", headers: { authorization: `Bearer ${FAKE_ENV.keys.capped}` } });
    expect(calls[0]!.url.endsWith("/key/budget")).toBe(true);
    expect(r.lines.join("\n")).not.toMatch(SECRETS);
  });

  it("exits 1 while a request limit is still set", async () => {
    const r = budgetResetReport(doc, (await read(keyBudget(4, 0))).budget);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toMatch(/^STILL LIMITED: .* request_limit 4, 3 used this period, 0 request\(s\) left/);
  });

  it("exits 2 when the budget is not readable, without calling it verified", async () => {
    const r = budgetResetReport(doc, (await read(loadTelemetryFixture("master-key-401"))).budget);
    expect(r.code).toBe(2);
    expect(r.lines.join("\n")).not.toMatch(/^verified/m);
    expect(r.lines.at(-1)).toMatch(/^NOT VERIFIED/);
  });
});
