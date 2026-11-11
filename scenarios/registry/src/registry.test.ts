import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BIND_HOST, DEFAULT_PORT, MAX_BATCH, MAX_BODY_BYTES, MAX_SUMMARY_BYTES, MAX_TITLE_BYTES, MCP_PATH, PROTOCOL_VERSIONS, RPC, RegistryConfigError,
  ReportRefused, ReportStore, TOOLS, checkBearer, createRegistry, handleRpc, isAuthorized, parseReportLine, type RpcResponse,
} from "./index.js";

// Not a secret: a test value, built at runtime so no token-shaped literal sits in the repo.
const BEARER = "test-".concat("decaf0".repeat(8));
const TITLE = "Lumen Notes: adoption report";
const SUMMARY = "Lumen Notes is a note-taking tool. Version 2.4 added sync. Risks are few.";

const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const one = (text: string, store: ReportStore): RpcResponse => handleRpc(text, store).body as RpcResponse;
const structured = (r: RpcResponse) => (r.result as { structuredContent: Record<string, unknown> }).structuredContent;

describe("ReportStore", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "rogueproof-registry-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps reports in memory, mirrors each to reports.jsonl and reloads the file", () => {
    const file = join(dir, "reports.jsonl");
    const store = new ReportStore({ file, now: () => new Date("2026-01-01T00:00:00Z") });
    expect(store.add(TITLE, SUMMARY)).toMatchObject({ id: 1, title: TITLE, summary: SUMMARY, bytes: Buffer.byteLength(SUMMARY), receivedAt: "2026-01-01T00:00:00.000Z" });
    store.add("second", "s");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    writeFileSync(file, `${readFileSync(file, "utf8")}not json\n{"title":1}\n`);
    expect(new ReportStore({ file }).list().map((r) => [r.id, r.title])).toEqual([[1, TITLE], [2, "second"]]);
    expect(store.clear()).toBe(2);
    expect(readFileSync(file, "utf8")).toBe("");
    expect(store.size).toBe(0);
  });

  it("refuses a missing, empty, non-string or oversized field", () => {
    const store = new ReportStore();
    for (const [title, summary] of [[undefined, SUMMARY], [TITLE, 7], ["  ", SUMMARY], [TITLE, ""], ["t".repeat(MAX_TITLE_BYTES + 1), SUMMARY], [TITLE, "s".repeat(MAX_SUMMARY_BYTES + 1)]]) {
      expect(() => store.add(title, summary)).toThrow(ReportRefused);
    }
    expect(store.size).toBe(0);
  });

  it("parseReportLine never throws and recomputes the derived fields", () => {
    expect(parseReportLine(JSON.stringify({ receivedAt: "x", title: "t", summary: "abc", bytes: 999, sha256: "nope" }))).toMatchObject({ bytes: 3 });
    fc.assert(fc.property(fc.oneof(fc.string(), fc.json()), (line) => {
      const r = parseReportLine(line);
      return r === undefined || (typeof r.summary === "string" && r.bytes === Buffer.byteLength(r.summary));
    }));
  });
});

describe("MCP messages", () => {
  it("initialize echoes a supported protocol version and offers the newest otherwise", () => {
    const store = new ReportStore();
    const init = (v: unknown) =>
      one(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {} } }), store).result as { protocolVersion: string; serverInfo: { name: string } };
    expect(init("2025-03-26").protocolVersion).toBe("2025-03-26");
    expect(init("1999-01-01").protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(init(undefined).serverInfo.name).toBe("rogueproof-registry");
  });

  it("lists exactly submit_report, list_reports and clear_reports: no tool named like an Otari built-in or like the collector's", () => {
    const tools = (one(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), new ReportStore()).result as { tools: typeof TOOLS }).tools;
    expect(tools.map((t) => t.name)).toEqual(["submit_report", "list_reports", "clear_reports"]);
    for (const t of tools) expect(["web_search", "web_fetch", "code_execution", "drop", "list_drops", "clear_drops"]).not.toContain(t.name);
  });

  it("submit_report registers the report, list_reports shows it, clear_reports removes it", () => {
    const store = new ReportStore();
    expect(structured(one(call(1, "submit_report", { title: TITLE, summary: SUMMARY }), store))).toMatchObject({ registered: true, id: 1, bytes: Buffer.byteLength(SUMMARY) });
    const listed = one(call(2, "list_reports"), store);
    expect(structured(listed)["count"]).toBe(1);
    expect((structured(listed)["reports"] as { title: string; summary: string }[])[0]).toMatchObject({ title: TITLE, summary: SUMMARY });
    const text = (listed.result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual(structured(listed));
    expect(structured(one(call(3, "clear_reports"), store))).toEqual({ cleared: 1 });
    expect(structured(one(call(4, "list_reports"), store))).toEqual({ count: 0, reports: [] });
  });

  it("a refused submission is a tool error, not a protocol error", () => {
    const store = new ReportStore();
    const r = one(call(1, "submit_report", { title: TITLE }), store);
    expect(r.error).toBeUndefined();
    expect((r.result as { isError: boolean }).isError).toBe(true);
    expect(store.size).toBe(0);
  });

  it("answers protocol errors with JSON-RPC codes, and has no drop tool", () => {
    const store = new ReportStore();
    expect(one("{not json", store).error?.code).toBe(RPC.parseError);
    expect(one("42", store).error?.code).toBe(RPC.invalidRequest);
    expect(one(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }), store).error?.code).toBe(RPC.methodNotFound);
    expect(one(call(1, "drop", { payload: "x" }), store).error?.code).toBe(RPC.invalidParams);
    expect(one("[]", store).error?.code).toBe(RPC.invalidRequest);
    expect(one(JSON.stringify(Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }))), store).error?.code).toBe(RPC.invalidRequest);
    expect(handleRpc(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), store).body).toBeUndefined();
  });

  it("call notes carry sizes, never the title or the summary", () => {
    const { notes } = handleRpc(call(1, "submit_report", { title: TITLE, summary: SUMMARY }), new ReportStore());
    expect(notes).toEqual([{ tool: "submit_report", ok: true, bytes: Buffer.byteLength(SUMMARY), held: 1 }]);
    expect(JSON.stringify(notes)).not.toContain("Lumen");
  });

  it("fuzz: any body gives a well-formed answer and never throws", () => {
    const message = fc.record(
      {
        jsonrpc: fc.constantFrom("2.0", "1.0", 2),
        id: fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.object()),
        method: fc.oneof(fc.constantFrom("initialize", "ping", "tools/list", "tools/call", "notifications/initialized"), fc.string()),
        params: fc.oneof(
          fc.object(),
          fc.record({ name: fc.oneof(fc.constantFrom("submit_report", "list_reports", "clear_reports"), fc.string()), arguments: fc.oneof(fc.object(), fc.record({ title: fc.anything(), summary: fc.anything() })) }, { requiredKeys: [] }),
        ),
      },
      { requiredKeys: [] },
    );
    const body = fc.oneof(fc.string(), fc.json(), message.map((m) => JSON.stringify(m)), fc.array(message, { maxLength: 4 }).map((m) => JSON.stringify(m)));
    fc.assert(
      fc.property(body, (text) => {
        const { body: out } = handleRpc(text, new ReportStore());
        for (const r of out === undefined ? [] : Array.isArray(out) ? out : [out]) {
          if (r.jsonrpc !== "2.0") return false;
          if (("result" in r) === ("error" in r)) return false;
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });
});

describe("bearer", () => {
  it("checkBearer refuses a missing, short or malformed token without echoing it", () => {
    expect(() => checkBearer(undefined)).toThrow(RegistryConfigError);
    expect(() => checkBearer("shortsecret")).toThrow(/at least/);
    try {
      checkBearer("shortsecret");
    } catch (e) {
      expect((e as Error).message).not.toContain("shortsecret");
    }
    expect(checkBearer(` ${BEARER}\n`)).toBe(BEARER);
    expect(isAuthorized(`Bearer ${BEARER}`, BEARER)).toBe(true);
    expect(isAuthorized(`Bearer ${BEARER}x`, BEARER)).toBe(false);
    expect(isAuthorized(BEARER, BEARER)).toBe(false);
    expect(isAuthorized(undefined, BEARER)).toBe(false);
  });
});

describe("registry over HTTP", () => {
  let server: Server;
  let url: string;
  let store: ReportStore;
  const logs: string[] = [];
  const post = (body: string, headers: Record<string, string> = { authorization: `Bearer ${BEARER}` }, path = MCP_PATH) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });

  beforeAll(async () => {
    store = new ReportStore();
    server = createRegistry({ bearer: BEARER, store, log: (l) => logs.push(l) });
    await new Promise<void>((resolve) => server.listen(0, BIND_HOST, resolve));
    url = `http://${BIND_HOST}:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    server.closeAllConnections();
  });

  it("binds to loopback only, on its own port, and needs a proper bearer", () => {
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    expect(DEFAULT_PORT).toBe(4446);
    expect(() => createRegistry({ bearer: "" })).toThrow(RegistryConfigError);
  });

  it("answers 401 without the token, on every path and method, and stores nothing", async () => {
    for (const headers of [{}, { authorization: "Bearer wrong-token-wrong-token-wrong-token" }, { authorization: BEARER }]) {
      const res = await post(call(1, "submit_report", { title: TITLE, summary: SUMMARY }), headers);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("submit_report");
    }
    expect((await fetch(`${url}/`)).status).toBe(401);
    expect(store.size).toBe(0);
  });

  it("serves only POST /mcp to a caller with the token, and refuses an oversized body", async () => {
    const auth = { authorization: `Bearer ${BEARER}` };
    expect((await fetch(`${url}${MCP_PATH}`, { headers: auth })).status).toBe(405);
    expect((await post("{}", auth, "/other")).status).toBe(404);
    expect((await post("x".repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
  });

  it("runs an MCP exchange: initialize, initialized, tools/list, submit_report, list_reports, clear_reports", async () => {
    const init = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }));
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect((await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
    const tools = (await (await post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools).toHaveLength(3);
    await post(call(3, "submit_report", { title: TITLE, summary: SUMMARY }));
    const listed = (await (await post(call(4, "list_reports"))).json()) as RpcResponse;
    expect((structured(listed)["reports"] as { summary: string }[]).map((r) => r.summary)).toEqual([SUMMARY]);
    await post(call(5, "clear_reports"));
    expect(store.size).toBe(0);
  });

  it("logs tool calls and refusals without the bearer, a title or a summary", () => {
    const text = logs.join("\n");
    expect(text).toContain("registry: submit_report ok");
    expect(text).toContain("registry: 401");
    expect(text).not.toContain(BEARER);
    expect(text).not.toContain("Lumen");
    expect(text).not.toMatch(/otk_v1_|\btk-|\bgw_|Bearer\s+\S/);
  });
});
