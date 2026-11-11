import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { createHoneypot, DEFAULT_HOST, DEFAULT_PORT, normalizePrefix } from "./server.js";

/**
 * `pnpm honeypot`: serves the site on 127.0.0.1:4444 under HONEYPOT_PREFIX.
 * The prefix comes from the environment, else from the repo's `.env`. Only that
 * one key is read from the file: the honeypot has no business holding any other.
 */
function prefixFromDotEnv(): string | undefined {
  const file = fileURLToPath(new URL("../../../.env", import.meta.url));
  try {
    return parseEnv(readFileSync(file, "utf8"))["HONEYPOT_PREFIX"];
  } catch {
    return undefined;
  }
}

function port(): number {
  const raw = process.env["HONEYPOT_PORT"];
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`HONEYPOT_PORT is not a valid port: ${JSON.stringify(raw)}`);
  }
  return value;
}

const prefix = normalizePrefix(process.env["HONEYPOT_PREFIX"] ?? prefixFromDotEnv());
const listenPort = port();
const server = await createHoneypot({ prefix });

server.on("error", (error) => {
  console.error(`honeypot: ${error.message}`);
  process.exit(1);
});
server.listen(listenPort, DEFAULT_HOST, () => {
  console.log(`honeypot: http://localhost:${listenPort}${prefix}/  (changelog: ${prefix}/changelog.html)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
