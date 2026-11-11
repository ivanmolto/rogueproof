// HTTP front of the collector: MCP Streamable HTTP on one endpoint, POST only,
// one JSON answer per POST, no sessions and no SSE stream. Every request must
// carry the bearer token; the check runs before the body is read.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { handleRpc, type CallNote } from "./mcp.js";
import { DropStore } from "./store.js";

/** Loopback only: the tunnel is the one public way in. */
export const BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4445;
export const MCP_PATH = "/mcp";
/** Request bodies above this are refused unread. Leaves room for a full-size payload once JSON-escaped. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** A shorter bearer is refused at start: `openssl rand -hex 32` gives 64 characters. */
export const MIN_BEARER_LENGTH = 32;

export class CollectorConfigError extends Error {
  override readonly name = "CollectorConfigError";
}

/** Validates the bearer at start. Messages name the variable, never its value. */
export function checkBearer(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "") throw new CollectorConfigError("COLLECTOR_BEARER is not set (openssl rand -hex 32; see sandbox/TUNNEL.md)");
  if (value.length < MIN_BEARER_LENGTH) throw new CollectorConfigError(`COLLECTOR_BEARER must be at least ${MIN_BEARER_LENGTH} characters`);
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(value)) throw new CollectorConfigError("COLLECTOR_BEARER has characters a bearer token cannot hold");
  return value;
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** True when the Authorization header is `Bearer <expected>`. Compares digests, so the time taken does not depend on the token. */
export function isAuthorized(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false;
  const match = /^Bearer +(\S+)$/i.exec(header);
  if (match?.[1] === undefined) return false;
  return timingSafeEqual(digest(match[1]), digest(expected));
}

export interface CollectorOptions {
  readonly bearer: string;
  /** Defaults to a memory-only store. */
  readonly store?: DropStore;
  /** One line per tool call or refused request. Never receives the bearer or a payload. */
  readonly log?: (line: string) => void;
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) over = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

const noteLine = (n: CallNote): string =>
  `collector: ${n.tool} ${n.ok ? "ok" : "refused"}${n.bytes === undefined ? "" : ` ${n.bytes} bytes`} (holding ${n.held})`;

/** Builds the collector HTTP server (not yet listening). Listen on BIND_HOST. */
export function createCollector(options: CollectorOptions): Server {
  const bearer = checkBearer(options.bearer);
  const store = options.store ?? new DropStore();
  const log = options.log ?? (() => {});

  return createServer((req, res) => {
    const send = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
      const buffer = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
      res.writeHead(status, {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "content-length": buffer.byteLength,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex",
        ...extra,
      });
      res.end(buffer);
    };

    // Auth first, for every path and method: without the token the collector says nothing about itself.
    if (!isAuthorized(req.headers.authorization, bearer)) {
      log(`collector: 401 ${req.method ?? "?"} (no valid bearer)`);
      req.resume();
      send(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    const path = (req.url ?? "/").split(/[?#]/, 1)[0];
    if (path !== MCP_PATH) {
      req.resume();
      send(404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      // No server-initiated stream (GET) and no session to end (DELETE).
      req.resume();
      send(405, { error: "method not allowed" }, { allow: "POST" });
      return;
    }
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
      req.resume();
      send(413, { error: "body too large" });
      return;
    }
    void readBody(req).then((text) => {
      if (text === undefined) {
        send(413, { error: "body too large" });
        return;
      }
      try {
        const { body, notes } = handleRpc(text, store);
        for (const note of notes) log(noteLine(note));
        // Only notifications came in: 202, no body (Streamable HTTP).
        if (body === undefined) send(202, undefined);
        else send(200, body);
      } catch (error) {
        // Only the store's file I/O can land here.
        log(`collector: 500 ${error instanceof Error ? error.name : "error"}`);
        send(500, { error: "collector failed" });
      }
    });
  });
}
