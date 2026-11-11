import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { BIND_HOST, DEFAULT_PORT, MCP_PATH, RegistryConfigError, checkBearer, createRegistry } from "./server.js";
import { ReportStore } from "./store.js";

/**
 * `pnpm registry`: the MCP mock on 127.0.0.1:4446/mcp, submissions mirrored to
 * runs/registry/reports.jsonl (gitignored). The bearer comes from the
 * environment, else from the repo's `.env`. Only that one key is read from the
 * file, and it is never printed.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_REPORTS_FILE = `${REPO_ROOT}runs/registry/reports.jsonl`;

function bearerFromDotEnv(): string | undefined {
  try {
    return parseEnv(readFileSync(`${REPO_ROOT}.env`, "utf8"))["REGISTRY_BEARER"];
  } catch {
    return undefined;
  }
}

function port(): number {
  const raw = process.env["REGISTRY_PORT"];
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RegistryConfigError(`REGISTRY_PORT is not a valid port: ${JSON.stringify(raw)}`);
  }
  return value;
}

try {
  const bearer = checkBearer(process.env["REGISTRY_BEARER"] ?? bearerFromDotEnv());
  const listenPort = port();
  const file = process.env["REGISTRY_REPORTS_FILE"] || DEFAULT_REPORTS_FILE;
  const store = new ReportStore({ file });
  const server = createRegistry({ bearer, store, log: (line) => console.log(line) });

  server.on("error", (error) => {
    console.error(`registry: ${error.message}`);
    process.exit(1);
  });
  server.listen(listenPort, BIND_HOST, () => {
    console.log(`registry: MCP (streamable HTTP, bearer token required) on http://${BIND_HOST}:${listenPort}${MCP_PATH}`);
    console.log(`registry: holding ${store.size} report(s); file ${file}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
} catch (error) {
  if (!(error instanceof RegistryConfigError)) throw error;
  console.error(`registry: ${error.message}`);
  process.exit(1);
}
