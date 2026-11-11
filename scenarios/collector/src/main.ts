import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { BIND_HOST, CollectorConfigError, DEFAULT_PORT, MCP_PATH, checkBearer, createCollector } from "./server.js";
import { DropStore } from "./store.js";

/**
 * `pnpm collector`: the MCP mock on 127.0.0.1:4445/mcp, drops mirrored to
 * runs/collector/drops.jsonl (gitignored). The bearer comes from the
 * environment, else from the repo's `.env`. Only that one key is read from the
 * file, and it is never printed.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_DROPS_FILE = `${REPO_ROOT}runs/collector/drops.jsonl`;

function bearerFromDotEnv(): string | undefined {
  try {
    return parseEnv(readFileSync(`${REPO_ROOT}.env`, "utf8"))["COLLECTOR_BEARER"];
  } catch {
    return undefined;
  }
}

function port(): number {
  const raw = process.env["COLLECTOR_PORT"];
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new CollectorConfigError(`COLLECTOR_PORT is not a valid port: ${JSON.stringify(raw)}`);
  }
  return value;
}

try {
  const bearer = checkBearer(process.env["COLLECTOR_BEARER"] ?? bearerFromDotEnv());
  const listenPort = port();
  const file = process.env["COLLECTOR_DROPS_FILE"] || DEFAULT_DROPS_FILE;
  const store = new DropStore({ file });
  const server = createCollector({ bearer, store, log: (line) => console.log(line) });

  server.on("error", (error) => {
    console.error(`collector: ${error.message}`);
    process.exit(1);
  });
  server.listen(listenPort, BIND_HOST, () => {
    console.log(`collector: MCP (streamable HTTP, bearer token required) on http://${BIND_HOST}:${listenPort}${MCP_PATH}`);
    console.log(`collector: holding ${store.size} drop(s); file ${file}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
} catch (error) {
  if (!(error instanceof CollectorConfigError)) throw error;
  console.error(`collector: ${error.message}`);
  process.exit(1);
}
