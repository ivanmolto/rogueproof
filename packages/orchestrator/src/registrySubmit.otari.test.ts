// Decision 003, live: one request with `mcp_server_ids: [collector, registry]`
// makes the hosted gateway call the report registry's `submit_report` through
// the tunnel, and leaves the collector alone. It answers the one thing the
// decision could not take from the docs: that two registered MCP servers work
// on one request. Needs `pnpm collector`, `pnpm registry` and `pnpm tunnel`
// running, both servers registered (otari-config/apply.md, steps 7 and 8) and
// RUN_OTARI=1. One model call.
//
// Evidence is the `mcp` entry in `otari_tool_calls` and what the registry holds
// afterwards, never the model's reply. The title is a random marker made here.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeOtari } from "@rogueproof/testing";
import { beforeAll, expect, it } from "vitest";
import { OtariClient, findRepoRoot, loadDotEnv, readOtariEnv, redact, type ChatResult, type OtariMcpCall } from "./otari/index.js";
import { registryServerId } from "./run/cli.js";
import { COLLECTOR_MCP_PATH, REGISTRY_MCP_PATH, REGISTRY_SURFACE, REGISTRY_TOOL, createMcpCollector } from "./run/index.js";
import { COLLECTOR_PORT, REGISTRY_PORT, readTunnelConfig, redactLine } from "./tunnel/config.js";

const SECRET_SHAPES = /otk_v1_|\btk-[A-Za-z0-9]|\bgw_[A-Za-z0-9]|\beyJ[A-Za-z0-9_=+/-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/;

describeOtari("registry: submit_report through mcp_server_ids, next to the collector", () => {
  const root = findRepoRoot(import.meta.dirname) ?? process.cwd();
  const dir = join(root, "docs", "evidence", "day4");
  const config = JSON.parse(readFileSync(join(root, "otari-config", "mcp", "registry.json"), "utf8")) as { name: string };
  const marker = `rogueproof-registry-check-${randomBytes(6).toString("hex")}`;
  let bearers: string[] = [];
  let token = "";
  let evidenceFile = "";
  let withoutBearer = 0;
  let result: ChatResult;
  let calls: OtariMcpCall[] = [];
  let held: string[] = [];
  let drops = -1;
  let registry: ReturnType<typeof createMcpCollector>;

  beforeAll(async () => {
    loadDotEnv(root);
    const env = readOtariEnv();
    const tunnel = readTunnelConfig();
    token = tunnel.token;
    if (tunnel.registryOrigin === undefined) throw new Error("REGISTRY_PUBLIC_URL is not set (sandbox/TUNNEL.md)");
    const collectorId = (process.env["COLLECTOR_MCP_SERVER_ID"] ?? "").trim();
    if (collectorId === "") throw new Error("COLLECTOR_MCP_SERVER_ID is not set");
    const registryId = registryServerId(root);
    const collectorBearer = (process.env["COLLECTOR_BEARER"] ?? "").trim();
    const registryBearer = (process.env["REGISTRY_BEARER"] ?? "").trim();
    bearers = [collectorBearer, registryBearer];

    // Preflight from this machine, so a stopped registry or tunnel is not mistaken for a gateway finding.
    const anonymous = await fetch(`${tunnel.registryOrigin}${REGISTRY_MCP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(20_000),
    });
    withoutBearer = anonymous.status;
    if (withoutBearer !== 401) {
      throw new Error(`the public registry answered ${withoutBearer} without a bearer (expected 401); start \`pnpm registry\` and \`pnpm tunnel\` first (sandbox/TUNNEL.md)`);
    }
    registry = createMcpCollector({ url: `http://127.0.0.1:${REGISTRY_PORT}${REGISTRY_MCP_PATH}`, bearer: registryBearer, surface: REGISTRY_SURFACE });
    const collector = createMcpCollector({ url: `http://127.0.0.1:${COLLECTOR_PORT}${COLLECTOR_MCP_PATH}`, bearer: collectorBearer });
    await registry.clear();
    await collector.clear();

    const client = new OtariClient({ env });
    result = await client.chat(
      "agent",
      [{ role: "user", content: `Call the ${REGISTRY_TOOL} tool exactly once, with the title "${marker}" and the summary "Connection check.". Call no other tool. Then reply with the single word: done` }],
      { mcpServerIds: [collectorId, registryId], maxTokens: 512 },
    );
    calls = result.otariToolCalls.filter((c): c is OtariMcpCall => c.type === "mcp");
    held = await registry.payloads();
    drops = await collector.count();

    mkdirSync(dir, { recursive: true });
    evidenceFile = join(dir, `mcp-registry-${env.profile}.json`);
    const run = {
      date: new Date().toISOString(),
      profile: env.profile,
      outcome: result.outcome,
      status: result.status,
      requestId: result.requestId,
      servedBy: [result.headers["otari-provider"], result.headers["otari-model"]].filter(Boolean).join(" · "),
      cost: result.cost,
      serverIds: [collectorId, registryId],
      mcpCalls: calls.map((c) => ({ id: c.id, server: c.server, name: c.name, status: c.status, output: c.output })),
      registryHeld: held.length,
      markerHeld: held.some((h) => h.includes(marker)),
      collectorHeld: drops,
      publicStatusWithoutBearer: withoutBearer,
    };
    const record = redact({ run, record: client.recorder.records.at(-1) });
    writeFileSync(evidenceFile, redactLine(JSON.stringify(record, null, 2), [token, ...bearers]) + "\n");
  }, 180_000);

  it("the gateway accepted two MCP servers on one request", () => {
    expect(["ok", "fallback"]).toContain(result.outcome);
  });

  it("otari_tool_calls has a completed mcp entry naming the registry and submit_report", () => {
    const submit = calls.find((c) => c.name === REGISTRY_TOOL);
    expect(submit, `mcp entries: ${JSON.stringify(calls.map((c) => [c.server, c.name, c.status]))}`).toBeDefined();
    expect(submit?.status).toBe("completed");
    expect(submit?.server).toBe(config.name);
  });

  it("list_reports shows the report this request sent, and the collector was not touched", () => {
    expect(held.some((h) => h.includes(marker))).toBe(true);
    expect(calls.some((c) => c.name === "drop")).toBe(false);
    expect(drops).toBe(0);
  });

  it("the public endpoint refuses a caller without the bearer", () => {
    expect(withoutBearer).toBe(401);
  });

  it("clear_reports empties the registry", async () => {
    await registry.clear();
    expect(await registry.count()).toBe(0);
  });

  it("no key, bearer or tunnel token in the saved evidence", () => {
    const text = readFileSync(evidenceFile, "utf8");
    expect(text).not.toContain(token);
    for (const b of bearers) expect(text).not.toContain(b);
    expect(text).not.toMatch(SECRET_SHAPES);
  });
});
