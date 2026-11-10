// Task 1.4: the real (redacted) hosted responses saved by the gateway-tools spike
// parse with the 1.3 types. docs/ is a private, gitignored tree until the
// submission review, so this suite skips with a printed reason when it is absent.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "./env.js";
import { parseOtariToolCalls } from "./toolCalls.js";

const dir = join(findRepoRoot(import.meta.dirname) ?? "", "docs", "spikes", "gateway-tools");
const present = existsSync(dir);
if (!present) console.log(`[skip] ${dir} is absent (private spike notes); gateway-tools spike parse tests skipped`);

interface Pair {
  request: { body: Record<string, unknown> };
  response: { status: number; headers: Record<string, string>; body: Record<string, unknown> };
}
const load = (name: string): Pair => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Pair;
const calls = (name: string) => parseOtariToolCalls(load(name).response.body["otari_tool_calls"]);

describe.skipIf(!present)("gateway-tools spike: saved hosted responses parse with the 1.3 types", () => {
  it("web fetch: one completed web_fetch entry with the requested URL (live entries carry no sources)", () => {
    const c = calls("01-web-fetch");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ type: "web_fetch", status: "completed", url: "https://example.com", sources: [] });
    expect(c[0]?.id).toMatch(/^otari_wf_/);
  });

  it("code execution: stdout, stderr and exit code come back in the entry (no file_ids live)", () => {
    const c = calls("02-code-execution");
    expect(c).toHaveLength(1);
    const e = c[0];
    if (e?.type !== "code_execution") throw new Error("expected a code_execution entry");
    expect(e.status).toBe("completed");
    expect(e.id).toMatch(/^otari_ci_/);
    expect(e.stdout.split("\n")[0]).toBe("5050");
    expect(e.exit_code).toBe(0);
    expect(e.file_ids).toEqual([]);
  });

  it("web fetch + code execution in one request is NOT refused on hosted: 200 with both entries", () => {
    const p = load("03-web-plus-code");
    expect(p.response.status).toBe(200);
    expect(calls("03-web-plus-code").map((c) => c.type)).toEqual(["web_fetch", "code_execution"]);
  });

  it("MCP refusals are {detail}-only bodies: unknown id 404, inline URL 400", () => {
    expect(load("04a-mcp-unknown-id").response).toMatchObject({ status: 404, body: { detail: expect.stringMatching(/not found/) } });
    expect(load("04b-mcp-inline").response).toMatchObject({ status: 400, body: { detail: expect.stringMatching(/mcp_server_ids/) } });
    expect(calls("04a-mcp-unknown-id")).toEqual([]);
  });

  it("no saved pair contains a key or bearer token", () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text).not.toMatch(/otk_v1_|\btk-[A-Za-z0-9]|\bgw_[A-Za-z0-9]|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/);
    }
  });
});
