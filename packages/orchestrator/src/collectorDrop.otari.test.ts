// Task 3.2, live: one request with `mcp_server_ids: [collector]` makes the
// hosted gateway call the mock collector's `drop` through the tunnel. Needs
// `pnpm collector` and `pnpm tunnel` running, the server registered in the
// workspace (otari-config/apply.md, step 7) and RUN_OTARI=1. One model call.
//
// Evidence that the call happened is the `mcp` entry in `otari_tool_calls` and
// the payload the collector holds afterwards, never the model's reply. The
// payload is a random marker made here, so finding it in the collector means
// this request put it there.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeOtari } from "@rogueproof/testing";
import { beforeAll, expect, it } from "vitest";
import { OtariClient, findRepoRoot, loadDotEnv, readOtariEnv, redact, type ChatResult, type OtariMcpCall } from "./otari/index.js";
import { COLLECTOR_MCP_PATH, createMcpCollector } from "./run/index.js";
import { COLLECTOR_PORT, readTunnelConfig, redactLine } from "./tunnel/config.js";

const SECRET_SHAPES = /otk_v1_|\btk-[A-Za-z0-9]|\bgw_[A-Za-z0-9]|\beyJ[A-Za-z0-9_=+/-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/;

describeOtari("collector: drop through mcp_server_ids", () => {
  const root = findRepoRoot(import.meta.dirname) ?? process.cwd();
  const day3 = join(root, "docs", "evidence", "day3");
  const config = JSON.parse(readFileSync(join(root, "otari-config", "mcp", "collector.json"), "utf8")) as { name: string; serverId: string | null };
  const marker = `rogueproof-mcp-check-${randomBytes(6).toString("hex")}`;
  let publicMcpUrl = "";
  let bearer = "";
  let token = "";
  let profile = "";
  let evidenceFile = "";
  let withoutBearer = 0;
  let result: ChatResult;
  let calls: OtariMcpCall[] = [];
  let held: string[] = [];
  let operator: ReturnType<typeof createMcpCollector>;

  beforeAll(async () => {
    loadDotEnv(root);
    const env = readOtariEnv();
    profile = env.profile;
    const tunnel = readTunnelConfig();
    token = tunnel.token;
    bearer = (process.env["COLLECTOR_BEARER"] ?? "").trim();
    publicMcpUrl = `${tunnel.collectorOrigin}${COLLECTOR_MCP_PATH}`;
    const id = (process.env["COLLECTOR_MCP_SERVER_ID"] ?? "").trim();
    if (id === "" || config.serverId === null) {
      throw new Error("the collector is not registered: follow otari-config/apply.md step 7, then set COLLECTOR_MCP_SERVER_ID and serverId in otari-config/mcp/collector.json");
    }
    if (id !== config.serverId) throw new Error("COLLECTOR_MCP_SERVER_ID and otari-config/mcp/collector.json name different servers");

    // Preflight from this machine, so a stopped collector or tunnel is not mistaken for a gateway finding.
    // Through the tunnel without the bearer: the collector must answer, and must refuse.
    const anonymous = await fetch(publicMcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(20_000),
    });
    withoutBearer = anonymous.status;
    if (withoutBearer !== 401) {
      throw new Error(`the public collector answered ${withoutBearer} without a bearer (expected 401); start \`pnpm collector\` and \`pnpm tunnel\` first (sandbox/TUNNEL.md)`);
    }
    operator = createMcpCollector({ url: `http://127.0.0.1:${COLLECTOR_PORT}${COLLECTOR_MCP_PATH}`, bearer });
    await operator.clear();
    if ((await operator.count()) !== 0) throw new Error("the collector is not empty after clear_drops");

    const client = new OtariClient({ env });
    result = await client.chat(
      "agent",
      [{ role: "user", content: `Call the drop tool exactly once with this payload: ${marker}\nThen reply with the single word: done` }],
      { mcpServerIds: [id], maxTokens: 512 },
    );
    calls = result.otariToolCalls.filter((c): c is OtariMcpCall => c.type === "mcp");
    held = await operator.payloads();

    mkdirSync(day3, { recursive: true });
    evidenceFile = join(day3, `mcp-drop-${profile}.json`);
    const run = {
      date: new Date().toISOString(),
      profile,
      outcome: result.outcome,
      status: result.status,
      requestId: result.requestId,
      servedBy: [result.headers["otari-provider"], result.headers["otari-model"]].filter(Boolean).join(" · "),
      cost: result.cost,
      serverId: id,
      mcpCalls: calls.map((c) => ({ id: c.id, server: c.server, name: c.name, status: c.status, output: c.output })),
      collectorHeld: held.length,
      markerHeld: held.includes(marker),
      publicStatusWithoutBearer: withoutBearer,
    };
    const record = redact({ run, record: client.recorder.records.at(-1) });
    writeFileSync(evidenceFile, redactLine(JSON.stringify(record, null, 2), [token, bearer]) + "\n");
  }, 180_000);

  it("otari_tool_calls has a completed mcp entry naming the server and the drop tool", () => {
    expect(["ok", "fallback"]).toContain(result.outcome);
    const drop = calls.find((c) => c.name === "drop");
    expect(drop, `mcp entries: ${JSON.stringify(calls.map((c) => [c.server, c.name, c.status]))}`).toBeDefined();
    expect(drop?.status).toBe("completed");
    // Live (2026-11-11): `server` is the name the server was registered under.
    expect(drop?.server).toBe(config.name);
  });

  it("list_drops shows the payload this request sent", () => {
    expect(held).toContain(marker);
  });

  it("the public endpoint refuses a caller without the bearer", () => {
    expect(withoutBearer).toBe(401);
  });

  it("clear_drops empties the collector", async () => {
    await operator.clear();
    expect(await operator.count()).toBe(0);
  });

  it("no key, bearer or tunnel token in the saved evidence", () => {
    const text = readFileSync(evidenceFile, "utf8");
    expect(text).not.toContain(token);
    expect(text).not.toContain(bearer);
    expect(text).not.toMatch(SECRET_SHAPES);
  });
});
