import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CollectorError, countDrops, createMcpCollector, parseRpcResponse } from "./collector.js";

const URL_ = "http://127.0.0.1:4445/mcp";
const BEARER = "collector-bearer-not-a-real-one-0001";

interface Seen {
  method: string;
  tool?: string;
  auth: string | null;
  session: string | null;
}
/** A minimal MCP Streamable HTTP server: JSON or SSE answers, one session id. */
function fakeCollector(o: { sse?: boolean; listResult?: unknown; status?: number; rpcError?: boolean; isError?: boolean } = {}) {
  const seen: Seen[] = [];
  const f = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const msg = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string } };
    const headers = new Headers(init?.headers);
    seen.push({ method: msg.method, ...(msg.params?.name ? { tool: msg.params.name } : {}), auth: headers.get("authorization"), session: headers.get("mcp-session-id") });
    if (o.status) return new Response("nope", { status: o.status });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    let result: unknown = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "collector", version: "0" } };
    if (msg.method === "tools/call") {
      result = msg.params?.name === "list_drops" ? (o.listResult ?? { content: [{ type: "text", text: "[]" }] }) : { content: [{ type: "text", text: "cleared" }] };
      if (o.isError) result = { content: [], isError: true };
    }
    const reply = o.rpcError && msg.method === "tools/call" ? { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `bad ${BEARER}` } } : { jsonrpc: "2.0", id: msg.id, result };
    const h = { "mcp-session-id": "sess-1" };
    return o.sse
      ? new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, { headers: { ...h, "content-type": "text/event-stream" } })
      : new Response(JSON.stringify(reply), { headers: { ...h, "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, seen };
}

describe("createMcpCollector", () => {
  it.each([false, true])("clear and count over MCP (sse=%s), bearer and session on every message", async (sse) => {
    const server = fakeCollector({ sse, listResult: { content: [{ type: "text", text: JSON.stringify([{ payload: "x" }, { payload: "y" }]) }] } });
    const c = createMcpCollector({ url: URL_, bearer: BEARER, fetch: server.fetch });
    await c.clear();
    expect(await c.count()).toBe(2);
    expect(server.seen.map((s) => s.tool ?? s.method)).toEqual([
      "initialize", "notifications/initialized", "clear_drops", "initialize", "notifications/initialized", "list_drops",
    ]);
    for (const s of server.seen) expect(s.auth).toBe(`Bearer ${BEARER}`);
    expect(server.seen.map((s) => s.session)).toEqual([null, "sess-1", "sess-1", null, "sess-1", "sess-1"]);
  });

  it("only ever calls clear_drops and list_drops, never drop", async () => {
    const server = fakeCollector();
    const c = createMcpCollector({ url: URL_, bearer: BEARER, fetch: server.fetch });
    await c.clear();
    await c.count();
    expect(server.seen.some((s) => s.tool === "drop")).toBe(false);
  });

  it("refuses to guess when list_drops cannot be read", async () => {
    const c = createMcpCollector({ url: URL_, bearer: BEARER, fetch: fakeCollector({ listResult: { content: [{ type: "text", text: "two drops" }] } }).fetch });
    await expect(c.count()).rejects.toThrow(/refusing to guess/);
  });

  it("throws CollectorError on HTTP errors, JSON-RPC errors, tool errors and transport failures, without the bearer", async () => {
    const down = (async () => Promise.reject(new TypeError(`fetch failed ${BEARER}`))) as typeof fetch;
    const cases: [typeof fetch, RegExp][] = [
      [fakeCollector({ status: 401 }).fetch, /HTTP 401/],
      [fakeCollector({ rpcError: true }).fetch, /refused tools\/call/],
      [fakeCollector({ isError: true }).fetch, /reported an error/],
      [down, /unreachable.*pnpm collector/],
    ];
    for (const [f, message] of cases) {
      const err = await createMcpCollector({ url: URL_, bearer: BEARER, fetch: f }).clear().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CollectorError);
      expect((err as Error).message).toMatch(message);
      expect((err as Error).message).not.toContain(BEARER);
    }
  });

  it("is a loopback-only operator client with a bearer", () => {
    for (const url of ["https://collector.example.dev/mcp", "http://10.0.0.5:4445/mcp", "http://example.com/mcp"]) {
      expect(() => createMcpCollector({ url, bearer: BEARER })).toThrow(/loopback/);
    }
    expect(() => createMcpCollector({ url: URL_, bearer: " " })).toThrow(/COLLECTOR_BEARER/);
  });
});

describe("countDrops", () => {
  const text = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
  it("reads the shapes a list_drops result can take", () => {
    expect(countDrops(text([]))).toBe(0);
    expect(countDrops(text([1, 2, 3]))).toBe(3);
    expect(countDrops(text({ drops: [{}] }))).toBe(1);
    expect(countDrops(text({ count: 4 }))).toBe(4);
    expect(countDrops({ structuredContent: { drops: [] }, content: [] })).toBe(0);
  });
  it("is undefined for anything else", () => {
    for (const v of [null, "x", {}, { content: "[]" }, text({ count: -1 }), text({ count: 1.5 }), text("none"), { content: [{ type: "text", text: "{" }] }]) {
      expect(countDrops(v)).toBeUndefined();
    }
  });
});

describe("parsers of collector output are total (fuzz)", () => {
  it("parseRpcResponse and countDrops never throw", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.integer(), fc.jsonValue(), (contentType, text, id, json) => {
        parseRpcResponse(contentType, text, id);
        parseRpcResponse("text/event-stream", `data: ${text}\n\ndata: ${JSON.stringify(json)}\n\n`, id);
        const n = countDrops(JSON.parse(JSON.stringify(json)));
        if (n !== undefined) expect(Number.isInteger(n) && n >= 0).toBe(true);
        const viaText = countDrops({ content: [{ type: "text", text: JSON.stringify(json) }] });
        if (viaText !== undefined) expect(Number.isInteger(viaText) && viaText >= 0).toBe(true);
      }),
    );
  });
  it("only returns the message with the asked id", () => {
    const body = JSON.stringify([{ jsonrpc: "2.0", id: 1, result: "a" }, { jsonrpc: "2.0", id: 2, result: "b" }, { jsonrpc: "2.0", id: 3, method: "ping" }]);
    expect(parseRpcResponse("application/json", body, 2)).toMatchObject({ result: "b" });
    expect(parseRpcResponse("application/json", body, 3)).toBeUndefined();
    expect(parseRpcResponse("application/json", body, 9)).toBeUndefined();
  });
});
