// The orchestrator's operator view of the mock collector (task 3.2): empty it
// before a run, count what it holds after. This is NOT the agent's path to the
// collector — the agent only reaches it through Otari (`mcp_server_ids`), over
// the tunnel. Here the orchestrator talks to the same MCP server on loopback,
// with the same bearer, and calls only `clear_drops` and `list_drops`.
//
// Transport: MCP Streamable HTTP (one JSON-RPC POST per message; the answer is
// JSON or a single SSE stream). The server is scenarios/collector (task 3.2);
// scenarios/ is not imported here, so its endpoint path and the shape of
// `list_drops`' result are restated in this one file (COLLECTOR_MCP_PATH,
// countDrops, dropPayloads) and collectorReal.test.ts runs this client against
// the real server.
import { redactString } from "../otari/index.js";

export interface CollectorPort {
  /** Empties the collector. Throws when it cannot be reached or refuses. */
  clear(): Promise<void>;
  /** Number of payloads the collector holds. Throws rather than guess. */
  count(): Promise<number>;
}

export const COLLECTOR_MCP_PATH = "/mcp";
export const MCP_PROTOCOL_VERSION = "2025-03-26";
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class CollectorError extends Error {
  override readonly name = "CollectorError";
}

export interface McpCollectorOptions {
  /** Loopback URL of the collector's MCP endpoint, e.g. http://127.0.0.1:4445/mcp */
  url: string;
  bearer: string;
  fetch?: typeof fetch;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON-RPC message with `id` out of a JSON body or an SSE stream. External input: never throws. */
export function parseRpcResponse(contentType: string, text: string, id: number): Record<string, unknown> | undefined {
  const candidates: string[] = [];
  if (/text\/event-stream/i.test(contentType)) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data !== "") candidates.push(data);
    }
  } else {
    candidates.push(text);
  }
  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isObj(m) && m["id"] === id && ("result" in m || "error" in m)) return m;
    }
  }
  return undefined;
}

/**
 * How many drops a `list_drops` tool result reports. Accepts the result's
 * `structuredContent` or its text content parsed as JSON, in the shapes
 * `[…]`, `{drops: […]}` or `{count: n}`. Anything else is undefined: the
 * caller refuses to call the collector empty on a result it cannot read.
 */
export function countDrops(result: unknown): number | undefined {
  if (!isObj(result)) return undefined;
  const from = (v: unknown): number | undefined => {
    if (Array.isArray(v)) return v.length;
    if (!isObj(v)) return undefined;
    if (Array.isArray(v["drops"])) return v["drops"].length;
    const n = v["count"];
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const structured = from(result["structuredContent"]);
  if (structured !== undefined) return structured;
  const content = result["content"];
  if (!Array.isArray(content)) return undefined;
  const text = content.map((c) => (isObj(c) && c["type"] === "text" && typeof c["text"] === "string" ? c["text"] : "")).join("");
  try {
    return from(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The payloads in a `list_drops` result (`{drops: [{payload}]}`), oldest first; undefined when it has another shape. */
export function dropPayloads(result: unknown): string[] | undefined {
  if (!isObj(result)) return undefined;
  const from = (v: unknown): string[] | undefined => {
    const drops = isObj(v) ? v["drops"] : v;
    if (!Array.isArray(drops)) return undefined;
    const out: string[] = [];
    for (const d of drops) {
      if (!isObj(d) || typeof d["payload"] !== "string") return undefined;
      out.push(d["payload"]);
    }
    return out;
  };
  const structured = from(result["structuredContent"]);
  if (structured !== undefined) return structured;
  const content = result["content"];
  if (!Array.isArray(content)) return undefined;
  const text = content.map((c) => (isObj(c) && c["type"] === "text" && typeof c["text"] === "string" ? c["text"] : "")).join("");
  try {
    return from(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export interface McpCollector extends CollectorPort {
  /** Every payload the collector holds, oldest first. Throws rather than guess. */
  payloads(): Promise<string[]>;
}

export function createMcpCollector(o: McpCollectorOptions): McpCollector {
  const url = new URL(o.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new CollectorError("the collector is a loopback mock; its operator URL must be http on 127.0.0.1");
  }
  if (o.bearer.trim() === "") throw new CollectorError("COLLECTOR_BEARER is not set");
  const doFetch = o.fetch ?? fetch;
  const clean = (s: string) => redactString(s).split(o.bearer).join("[REDACTED]");
  let nextId = 0;

  async function post(body: Record<string, unknown>, session: string | undefined): Promise<Response> {
    try {
      return await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${o.bearer}`,
          ...(session !== undefined ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new CollectorError(clean(`collector unreachable at ${url.origin} (is \`pnpm collector\` running?): ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  async function request(method: string, params: Record<string, unknown>, session: string | undefined): Promise<{ result: unknown; session: string | undefined }> {
    const id = ++nextId;
    const res = await post({ id, method, params }, session);
    const text = (await res.text()).slice(0, MAX_BODY_BYTES);
    if (!res.ok) throw new CollectorError(clean(`collector answered HTTP ${res.status} to ${method}`));
    const msg = parseRpcResponse(res.headers.get("content-type") ?? "", text, id);
    if (!msg) throw new CollectorError(`collector gave no JSON-RPC answer to ${method}`);
    if (msg["error"] !== undefined) {
      const err = msg["error"];
      throw new CollectorError(clean(`collector refused ${method}: ${isObj(err) && typeof err["message"] === "string" ? err["message"].slice(0, 200) : "error"}`));
    }
    return { result: msg["result"], session: res.headers.get("mcp-session-id") ?? session };
  }

  /** One short MCP session per operation: initialize, initialized, one tools/call. */
  async function callTool(name: "clear_drops" | "list_drops"): Promise<unknown> {
    const init = await request(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "rogueproof-orchestrator", version: "0.0.0" } },
      undefined,
    );
    await post({ method: "notifications/initialized" }, init.session);
    const { result } = await request("tools/call", { name, arguments: {} }, init.session);
    if (isObj(result) && result["isError"] === true) throw new CollectorError(`collector tool ${name} reported an error`);
    return result;
  }

  return {
    async clear() {
      await callTool("clear_drops");
    },
    async count() {
      const n = countDrops(await callTool("list_drops"));
      if (n === undefined) throw new CollectorError("could not read the collector's list_drops result; refusing to guess how many drops it holds");
      return n;
    },
    async payloads() {
      const p = dropPayloads(await callTool("list_drops"));
      if (p === undefined) throw new CollectorError("could not read the collector's list_drops result");
      return p;
    },
  };
}
