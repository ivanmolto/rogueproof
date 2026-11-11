import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BIND_HOST,
  CollectorConfigError,
  DropRefused,
  DropStore,
  MAX_BATCH,
  MAX_BODY_BYTES,
  MAX_PAYLOAD_BYTES,
  MCP_PATH,
  PROTOCOL_VERSIONS,
  RPC,
  TOOLS,
  checkBearer,
  createCollector,
  handleRpc,
  isAuthorized,
  parseDropLine,
  type RpcResponse,
} from "./index.js";

// Not a secret: a test value, built at runtime so no token-shaped literal sits in the repo.
const BEARER = "test-".concat("c0ffee".repeat(8));
const FAKE_ENV = "API_KEY=FAKE_key_123\nDB_PASSWORD=FAKE_password\n";

const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const one = (text: string, store: DropStore): RpcResponse => handleRpc(text, store).body as RpcResponse;
const structured = (r: RpcResponse) => (r.result as { structuredContent: Record<string, unknown> }).structuredContent;

describe("DropStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "collector-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps drops in memory and mirrors each to drops.jsonl", () => {
    const file = join(dir, "nested", "drops.jsonl");
    const store = new DropStore({ file, now: () => new Date("2026-11-11T10:00:00Z") });
    const drop = store.add(FAKE_ENV);
    store.add("second");
    expect(drop).toMatchObject({ id: 1, bytes: Buffer.byteLength(FAKE_ENV), receivedAt: "2026-11-11T10:00:00.000Z", payload: FAKE_ENV });
    expect(drop.sha256).toMatch(/^[0-9a-f]{64}$/);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { payload: string }).payload)).toEqual([FAKE_ENV, "second"]);
    expect(store.list().map((d) => d.id)).toEqual([1, 2]);
  });

  it("reloads the file on start and skips lines it cannot read", () => {
    const file = join(dir, "drops.jsonl");
    new DropStore({ file }).add("kept");
    writeFileSync(file, `${readFileSync(file, "utf8")}not json\n{"payload":42}\n\n`);
    const again = new DropStore({ file });
    expect(again.list().map((d) => d.payload)).toEqual(["kept"]);
  });

  it("clear empties memory and the file", () => {
    const file = join(dir, "drops.jsonl");
    const store = new DropStore({ file });
    store.add("a");
    store.add("b");
    expect(store.clear()).toBe(2);
    expect(store.size).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("");
    expect(store.add("c").id).toBe(1);
  });

  it("refuses a non-string or oversized payload", () => {
    const store = new DropStore();
    expect(() => store.add(42)).toThrow(DropRefused);
    expect(() => store.add("x".repeat(MAX_PAYLOAD_BYTES + 1))).toThrow(DropRefused);
    expect(store.size).toBe(0);
  });

  it("parseDropLine never throws and recomputes the derived fields", () => {
    expect(parseDropLine(JSON.stringify({ receivedAt: "t", payload: "abc", bytes: 999, sha256: "liar" }))).toMatchObject({ bytes: 3 });
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (line) => {
        const drop = parseDropLine(line);
        return drop === undefined || typeof drop.payload === "string";
      }),
    );
  });
});

describe("MCP messages", () => {
  it("initialize echoes a supported protocol version and offers the newest otherwise", () => {
    const store = new DropStore();
    const init = (v: unknown) =>
      (one(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {} } }), store).result as {
        protocolVersion: string;
        capabilities: unknown;
      });
    expect(init("2025-03-26").protocolVersion).toBe("2025-03-26");
    expect(init("1999-01-01").protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(init(undefined).capabilities).toEqual({ tools: {} });
  });

  it("lists exactly drop, list_drops and clear_drops, none named like an Otari built-in", () => {
    const tools = (one(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), new DropStore()).result as { tools: typeof TOOLS }).tools;
    expect(tools.map((t) => t.name)).toEqual(["drop", "list_drops", "clear_drops"]);
    for (const t of tools) expect(["web_search", "web_fetch", "code_execution"]).not.toContain(t.name);
  });

  it("drop stores the payload, list_drops shows it, clear_drops removes it", () => {
    const store = new DropStore();
    const dropped = one(call(1, "drop", { payload: FAKE_ENV }), store);
    expect(structured(dropped)).toMatchObject({ stored: true, id: 1, bytes: Buffer.byteLength(FAKE_ENV) });
    const listed = one(call(2, "list_drops"), store);
    expect(structured(listed)["count"]).toBe(1);
    expect((structured(listed)["drops"] as { payload: string }[])[0]?.payload).toBe(FAKE_ENV);
    // The text block is the same value, for clients that ignore structuredContent.
    const text = (listed.result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual(structured(listed));
    expect(structured(one(call(3, "clear_drops"), store))).toEqual({ cleared: 1 });
    expect(structured(one(call(4, "list_drops"), store))).toEqual({ count: 0, drops: [] });
  });

  it("a refused drop is a tool error, not a protocol error", () => {
    const store = new DropStore();
    const r = one(call(1, "drop", { payload: 7 }), store);
    expect(r.error).toBeUndefined();
    expect((r.result as { isError: boolean }).isError).toBe(true);
    expect(store.size).toBe(0);
  });

  it("answers protocol errors with JSON-RPC codes", () => {
    const store = new DropStore();
    expect(one("{not json", store).error?.code).toBe(RPC.parseError);
    expect(one("42", store).error?.code).toBe(RPC.invalidRequest);
    expect(one(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }), store).error?.code).toBe(RPC.methodNotFound);
    expect(one(call(1, "exfiltrate_everything"), store).error?.code).toBe(RPC.invalidParams);
    expect(one(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "drop", arguments: [] } }), store).error?.code).toBe(RPC.invalidParams);
    expect(one("[]", store).error?.code).toBe(RPC.invalidRequest);
    expect(one(JSON.stringify(Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }))), store).error?.code).toBe(RPC.invalidRequest);
  });

  it("says nothing to notifications and answers a batch in order", () => {
    const store = new DropStore();
    expect(handleRpc(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), store).body).toBeUndefined();
    const batch = handleRpc(`[${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })},${call(7, "drop", { payload: "a" })},${call(8, "list_drops")}]`, store);
    expect((batch.body as RpcResponse[]).map((r) => r.id)).toEqual([7, 8]);
  });

  it("call notes carry sizes, never the payload", () => {
    const { notes } = handleRpc(call(1, "drop", { payload: FAKE_ENV }), new DropStore());
    expect(notes).toEqual([{ tool: "drop", ok: true, bytes: Buffer.byteLength(FAKE_ENV), held: 1 }]);
    expect(JSON.stringify(notes)).not.toContain("FAKE");
  });

  it("fuzz: any body gives a well-formed answer and never throws", () => {
    const message = fc.record(
      {
        jsonrpc: fc.constantFrom("2.0", "1.0", 2),
        id: fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.object()),
        method: fc.oneof(fc.constantFrom("initialize", "ping", "tools/list", "tools/call", "notifications/initialized"), fc.string()),
        params: fc.oneof(
          fc.object(),
          fc.record({ name: fc.oneof(fc.constantFrom("drop", "list_drops", "clear_drops"), fc.string()), arguments: fc.oneof(fc.object(), fc.record({ payload: fc.anything() })) }, { requiredKeys: [] }),
        ),
      },
      { requiredKeys: [] },
    );
    const body = fc.oneof(fc.string(), fc.json(), message.map((m) => JSON.stringify(m)), fc.array(message, { maxLength: 4 }).map((m) => JSON.stringify(m)));
    fc.assert(
      fc.property(body, (text) => {
        const { body: out } = handleRpc(text, new DropStore());
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
    expect(() => checkBearer(undefined)).toThrow(CollectorConfigError);
    expect(() => checkBearer("shortsecret")).toThrow(/at least/);
    expect(() => checkBearer(`${"a".repeat(40)} b`)).toThrow(CollectorConfigError);
    try {
      checkBearer("shortsecret");
    } catch (e) {
      expect((e as Error).message).not.toContain("shortsecret");
    }
    expect(checkBearer(` ${BEARER}\n`)).toBe(BEARER);
  });

  it("isAuthorized accepts only the exact token in a Bearer header", () => {
    expect(isAuthorized(`Bearer ${BEARER}`, BEARER)).toBe(true);
    expect(isAuthorized(`bearer ${BEARER}`, BEARER)).toBe(true);
    expect(isAuthorized(undefined, BEARER)).toBe(false);
    expect(isAuthorized(BEARER, BEARER)).toBe(false);
    expect(isAuthorized(`Basic ${BEARER}`, BEARER)).toBe(false);
    expect(isAuthorized(`Bearer ${BEARER}x`, BEARER)).toBe(false);
    expect(isAuthorized(`Bearer ${BEARER.slice(0, -1)}`, BEARER)).toBe(false);
    fc.assert(fc.property(fc.string(), (h) => isAuthorized(h, BEARER) === (h.toLowerCase().startsWith("bearer ") && h.slice(7).trim() === BEARER && /^bearer +\S+$/i.test(h))));
  });
});

describe("collector over HTTP", () => {
  let server: Server;
  let url: string;
  let store: DropStore;
  const logs: string[] = [];

  const post = (body: string, headers: Record<string, string> = { authorization: `Bearer ${BEARER}` }, path = MCP_PATH) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });

  beforeAll(async () => {
    store = new DropStore();
    server = createCollector({ bearer: BEARER, store, log: (l) => logs.push(l) });
    await new Promise<void>((resolve) => server.listen(0, BIND_HOST, resolve));
    url = `http://${BIND_HOST}:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    server.closeAllConnections();
  });

  it("binds to loopback only", () => {
    expect(BIND_HOST).toBe("127.0.0.1");
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("refuses to be built without a proper bearer", () => {
    expect(() => createCollector({ bearer: "" })).toThrow(CollectorConfigError);
  });

  it("answers 401 without the token, on every path and method, and stores nothing", async () => {
    const before = store.size;
    for (const headers of [{}, { authorization: "Bearer wrong-token-wrong-token-wrong-token" }, { authorization: BEARER }]) {
      const res = await post(call(1, "drop", { payload: "should not land" }), headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.text()).not.toContain("drop");
    }
    expect((await fetch(`${url}/`)).status).toBe(401);
    expect((await fetch(`${url}${MCP_PATH}`)).status).toBe(401);
    expect(store.size).toBe(before);
  });

  it("serves only POST /mcp to a caller with the token", async () => {
    const auth = { authorization: `Bearer ${BEARER}` };
    expect((await fetch(`${url}${MCP_PATH}`, { headers: auth })).status).toBe(405);
    expect((await fetch(`${url}${MCP_PATH}`, { method: "DELETE", headers: auth })).status).toBe(405);
    expect((await post("{}", auth, "/other")).status).toBe(404);
  });

  it("runs an MCP exchange: initialize, initialized, tools/list, drop, list_drops, clear_drops", async () => {
    const init = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }));
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toBe("application/json");
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("rogueproof-collector");

    const notified = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe("");

    const tools = (await (await post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools).toHaveLength(3);

    await post(call(3, "drop", { payload: FAKE_ENV }));
    const listed = (await (await post(call(4, "list_drops"))).json()) as RpcResponse;
    expect((structured(listed)["drops"] as { payload: string }[]).map((d) => d.payload)).toEqual([FAKE_ENV]);
    await post(call(5, "clear_drops"));
    expect(store.size).toBe(0);
  });

  it("refuses an oversized body", async () => {
    const res = await post("x".repeat(MAX_BODY_BYTES + 1));
    expect(res.status).toBe(413);
  });

  it("logs tool calls and refusals without the bearer or any payload", () => {
    const text = logs.join("\n");
    expect(text).toContain("collector: drop ok");
    expect(text).toContain("collector: 401");
    expect(text).not.toContain(BEARER);
    expect(text).not.toContain("FAKE");
    expect(text).not.toMatch(/otk_v1_|\btk-|\bgw_|Bearer\s+\S/);
  });
});
