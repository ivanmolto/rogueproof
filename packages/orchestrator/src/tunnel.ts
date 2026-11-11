// pnpm tunnel: one authenticated Cloudflare Tunnel that exposes the honeypot, the
// collector and the report registry on our own domain, because Otari's gateway-run tools only reach
// the public web. The connector token comes from .env and is passed to
// cloudflared through its environment; it is never printed. Setup: sandbox/TUNNEL.md.
import { spawn } from "node:child_process";
import { loadDotEnv } from "./otari/env.js";
import {
  COLLECTOR_PORT,
  HONEYPOT_PORT,
  REGISTRY_PORT,
  TUNNEL_ARGV,
  TUNNEL_COMMAND,
  TunnelConfigError,
  childEnv,
  createLineRedactor,
  isConnectedLine,
  publicUrls,
  readTunnelConfig,
} from "./tunnel/config.js";

function main(): Promise<number> {
  loadDotEnv();
  const config = readTunnelConfig();
  const urls = publicUrls(config);
  const printUrls = (state: string): void => {
    console.log(`tunnel · ${state}`);
    console.log(`  honeypot   ${urls.honeypot}  ->  http://localhost:${HONEYPOT_PORT}   (pnpm honeypot)`);
    console.log(`  changelog  ${urls.changelog}`);
    console.log(`  collector  ${urls.collector}  ->  http://localhost:${COLLECTOR_PORT}   (pnpm collector)`);
    console.log(
      urls.registry !== undefined
        ? `  registry   ${urls.registry}  ->  http://localhost:${REGISTRY_PORT}   (pnpm registry)`
        : "  registry   REGISTRY_PUBLIC_URL is not set: runs need it (sandbox/TUNNEL.md)",
    );
  };
  printUrls("starting cloudflared (routes are defined in the Cloudflare dashboard)");

  return new Promise((resolve) => {
    const child = spawn(TUNNEL_COMMAND, [...TUNNEL_ARGV], { env: childEnv(config), stdio: ["ignore", "pipe", "pipe"] });
    let announced = false;
    const print = (lines: string[]): void => {
      for (const line of lines) {
        console.error(`cloudflared: ${line}`);
        if (!announced && isConnectedLine(line)) {
          announced = true;
          printUrls("connected");
        }
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      const redactor = createLineRedactor([config.token]);
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => print(redactor.push(chunk)));
      stream.on("end", () => print(redactor.flush()));
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      console.error(
        error.code === "ENOENT"
          ? "tunnel: cloudflared is not installed (brew install cloudflared; see sandbox/TUNNEL.md)"
          : `tunnel: could not start cloudflared (${error.code ?? "unknown error"})`,
      );
      resolve(2);
    });
    child.on("exit", (code, signal) => resolve(signal !== null ? 0 : (code ?? 1)));
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => child.kill(signal));
    }
  });
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // Config errors name the variable at fault and never its value.
    console.error(e instanceof TunnelConfigError ? `tunnel: ${e.message}` : "tunnel: unexpected failure");
    process.exit(2);
  },
);
