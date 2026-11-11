// Task 4.5: the workspace mirror check behind `run:safe --fallback-demo`, offline.
// The gateway is the fake fetch; every finding is read from what it answers.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_ENV_FALLBACK, fakeFetch, loadFixture, type FakeCall, type Fixture } from "../../test/fixtures.js";
import { OtariClient } from "../otari/index.js";
import { fallbackServerId, recordedMandate, runCli } from "./cli.js";
import { FALLBACK_COLLECTOR_ENV, FALLBACK_REGISTRY_ENV, FALLBACK_WORKSPACE, PIN_TRIES, PIN_WAIT_MS, RESTORE_REMINDER, checkFallbackWorkspace } from "./fallbackDemo.js";
import { RunRefused } from "./scenario.js";

const IDS = ["mcp_fake_collector_ft", "mcp_fake_registry_ft"];
const MANDATE = { profile: "test-guard", mode: "monitor" };
const verdict = (profile = "test-guard", mode = "monitor") => JSON.stringify([{ profile, mode, valid: false, score: 0.4, status: "evaluated" }]);
/** `null`: the response carries no Otari-Guardrails header at all. */
const withGuard = (fx: Fixture, header: string | null = verdict()): Fixture => {
  const out = structuredClone(fx);
  if (header !== null) out.headers["otari-guardrails"] = header;
  return out;
};
const rescued = () => withGuard(loadFixture("fallback", "rescued"));
const notRescued = () => withGuard(loadFixture("ok", "hello"));

function check(queue: Fixture[]) {
  const ff = fakeFetch(queue);
  const waits: number[] = [];
  const client = new OtariClient({ env: FAKE_ENV_FALLBACK, fetch: ff.fetch, sleep: () => Promise.resolve() });
  const result = checkFallbackWorkspace({ client, mcpServerIds: IDS, guardrail: MANDATE, sleep: async (ms) => void waits.push(ms) });
  return { result, sent: ff.calls, waits };
}
interface Body {
  model: string;
  tools?: { type: string }[];
  mcp_server_ids?: string[];
  user?: string;
  max_tokens?: number;
}
const body = (c: FakeCall) => c.body as Body;
const failed = (r: Awaited<ReturnType<typeof checkFallbackWorkspace>>) => r.findings.filter((f) => !f.ok).map((f) => f.check);

describe("checkFallbackWorkspace", () => {
  it("passes on a rescued, guarded research request and a served act request: two calls", async () => {
    const { result, sent, waits } = check([rescued(), rescued()]);
    const r = await result;
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(4);
    expect(r.calls).toBe(2);
    expect(r.costUsd).toBeCloseTo(0.00002, 8);
    expect(waits).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it("sends on the fallback-test key, the routing policy, one tool set per request, and no end user", async () => {
    const { result, sent } = check([rescued(), rescued()]);
    await result;
    const [research, act] = sent.map(body);
    for (const c of sent) expect(c.headers["authorization"]).toBe(`Bearer ${FAKE_ENV_FALLBACK.keys.fallback}`);
    for (const b of [research!, act!]) {
      expect(b.model).toBe("agent-primary");
      expect(b.user).toBeUndefined();
      expect(b.max_tokens).toBe(16);
    }
    expect(research!.tools!.map((t) => t.type)).toEqual(["otari_web_fetch", "otari_web_search"]);
    expect(research!.mcp_server_ids).toBeUndefined();
    expect(act!.tools!.every((t) => t.type === "function")).toBe(true);
    expect(act!.mcp_server_ids).toEqual(IDS);
  });

  it("waits for the pin: a first call still served by the main provider is asked again", async () => {
    const { result, sent, waits } = check([notRescued(), rescued(), rescued()]);
    const r = await result;
    expect(r.ok).toBe(true);
    expect(r.calls).toBe(3);
    expect(waits).toEqual([PIN_WAIT_MS]);
    expect(sent).toHaveLength(3);
  });

  it("fails when no call is rescued: the invalid key is not pinned", async () => {
    const { result, sent } = check([notRescued(), notRescued(), notRescued(), notRescued()]);
    const r = await result;
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual([expect.stringContaining("invalid provider key pinned")]);
    expect(sent).toHaveLength(PIN_TRIES + 1);
  });

  it("fails when the guardrail did not run, or ran in another mode or under another profile", async () => {
    for (const header of [null, verdict("test-guard", "block"), verdict("other-guard"), "not json"]) {
      const first = withGuard(loadFixture("fallback", "rescued"), header);
      const r = await check([first, rescued()]).result;
      expect(r.ok, String(header)).toBe(false);
      expect(failed(r)).toEqual([expect.stringContaining("inference guardrail mandated")]);
    }
  });

  it("fails on an MCP server the workspace does not know, with the gateway's words, and never retries it", async () => {
    const { result, sent } = check([rescued(), loadFixture("error", "mcp-server-not-found-404")]);
    const r = await result;
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual([expect.stringContaining("MCP servers registered")]);
    expect(r.findings.at(-1)!.detail).toMatch(/404.*not found/);
    expect(sent).toHaveLength(2);
  });

  it("web search not allowed in the workspace: the gateway's 403 fails the web finding with its own words, sent once", async () => {
    const { result, sent } = check([loadFixture("error", "web-access-disabled-403"), rescued()]);
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ ok: false, detail: "error (HTTP 403): web access is not enabled for this workspace" });
    // Nothing was served, so the pin and the guardrail cannot be read either; the MCP request is still sent.
    expect(failed(r)).toHaveLength(3);
    expect(r.findings[3]!.ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("a refused research request fails the web, pin and guardrail findings, and is not repeated", async () => {
    const { result, sent } = check([loadFixture("guardrail_blocked", "injection"), rescued()]);
    const r = await result;
    expect(r.ok).toBe(false);
    expect(failed(r)).toHaveLength(3);
    expect(sent).toHaveLength(2);
  });

  it("no finding carries a key or a bearer", async () => {
    const r = await check([notRescued(), notRescued(), notRescued(), loadFixture("error", "mcp-server-not-found-404")]).result;
    expect(JSON.stringify(r)).not.toMatch(/otk_v1_|\btk-|\bgw_|Bearer\s|otari-key/i);
  });
});

describe("the operator reminder", () => {
  it("names the workspace, the Reset action and the verification", () => {
    const text = RESTORE_REMINDER.join("\n");
    expect(text).toContain(FALLBACK_WORKSPACE);
    expect(text).toContain("Reset");
    expect(text).toContain("fallback-test.md");
  });
});

describe("fallback-demo configuration", () => {
  function repo(collector: unknown, mandate: unknown = { profile: "lakera-guard", mode: "monitor" }): string {
    const root = mkdtempSync(join(tmpdir(), "rogueproof-fd-"));
    mkdirSync(join(root, "otari-config", "mcp"), { recursive: true });
    mkdirSync(join(root, "otari-config", "guardrails"), { recursive: true });
    writeFileSync(join(root, "otari-config", "mcp", "collector.json"), JSON.stringify(collector));
    writeFileSync(join(root, "otari-config", "guardrails", "injection.json"), JSON.stringify({ mandate }));
    return root;
  }
  const recorded = (serverId: unknown) => ({ serverId: "main-id", otherWorkspaces: { [FALLBACK_WORKSPACE]: { serverId } } });

  it("takes the test workspace's server id when .env and otari-config agree", () => {
    expect(fallbackServerId(repo(recorded("ft-id")), "collector", { [FALLBACK_COLLECTOR_ENV]: " ft-id " })).toBe("ft-id");
  });

  it("refuses an unset id, an unregistered server (null), a mismatch and the main workspace's id", () => {
    expect(() => fallbackServerId(repo(recorded("ft-id")), "collector", {})).toThrow(new RegExp(FALLBACK_COLLECTOR_ENV));
    expect(() => fallbackServerId(repo(recorded(null)), "collector", { [FALLBACK_COLLECTOR_ENV]: "ft-id" })).toThrow(RunRefused);
    expect(() => fallbackServerId(repo(recorded("ft-id")), "collector", { [FALLBACK_COLLECTOR_ENV]: "main-id" })).toThrow(/different servers/);
    expect(() => fallbackServerId(repo({ serverId: "main-id" }), "collector", { [FALLBACK_COLLECTOR_ENV]: "main-id" })).toThrow(RunRefused);
    expect(() => fallbackServerId(repo(recorded("x")), "registry", { [FALLBACK_REGISTRY_ENV]: "x" })).toThrow(/missing or unreadable/);
  });

  it("reads the mandate to mirror, and refuses when none is recorded", () => {
    expect(recordedMandate(repo({}))).toEqual({ profile: "lakera-guard", mode: "monitor" });
    expect(() => recordedMandate(repo({}, { mode: "monitor" }))).toThrow(RunRefused);
    expect(() => recordedMandate(mkdtempSync(join(tmpdir(), "rogueproof-fd-")))).toThrow(RunRefused);
  });

  it("--fallback-demo is refused on any command but run:safe before anything is read", async () => {
    // parseArgs accepts the flag everywhere; the mode check is what stops it. Needs only the base env.
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        OTARI_BASE_URL: "https://fake.gateway.test/api/v1", MODEL_PROFILE: "rubric",
        OTARI_API_KEY_AGENT: "FAKE", OTARI_API_KEY_JUDGE: "FAKE", OTARI_API_KEY_REPORT: "FAKE", OTARI_API_KEY_CAPPED: "FAKE", OTARI_API_KEY_SERVICE: "FAKE",
      });
      await expect(runCli("permissive", ["--fallback-demo"])).rejects.toThrow(/run:safe flag/);
      await expect(runCli("budget", ["--fallback-demo"])).rejects.toThrow(/run:safe flag/);
      await expect(runCli("safe", ["--fallback-demo", "--agent-model", "B"])).rejects.toThrow(/no --agent-model/);
      process.env["MODEL_PROFILE"] = "dev";
      await expect(runCli("safe", ["--fallback-demo"])).rejects.toThrow(/MODEL_PROFILE=rubric/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
