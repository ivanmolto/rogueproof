// pnpm demo: honeypot + collector (MCP) + registry (MCP) + tunnel + dashboard in one
// command, then the URLs (task 6.1). Each service is the same entry point as its own
// pnpm script; this file only starts them, prefixes and redacts their output, and takes
// all of them down when one exits or on Ctrl-C. What gets started is demo/plan.ts.
// Never prints a key, a bearer or the tunnel token. Makes no gateway call.
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { findRepoRoot, loadDotEnv } from "./otari/env.js";
import { DemoConfigError, planDemo, type DemoService } from "./demo/plan.js";
import { createLineRedactor, isConnectedLine } from "./tunnel/config.js";

const READY_TIMEOUT_MS = 60_000;

/**
 * True when something accepts a connection on the port, on either loopback family. A bind test is not
 * enough: a server on the IPv6 wildcard (next dev, a Docker port forward) leaves 127.0.0.1 bindable.
 */
function listening(port: number): Promise<boolean> {
  const tryHost = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ port, host });
      const done = (up: boolean): void => {
        socket.destroy();
        resolve(up);
      };
      socket.setTimeout(1000, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return Promise.all([tryHost("127.0.0.1"), tryHost("::1")]).then((r) => r.some(Boolean));
}

async function main(): Promise<number> {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) throw new DemoConfigError("run this from inside the rogueproof repository");
  loadDotEnv();
  const plan = planDemo(repoRoot, process.env);
  const secrets = ["TUNNEL_TOKEN", "COLLECTOR_BEARER", "REGISTRY_BEARER"].map((k) => (process.env[k] ?? "").trim()).filter((v) => v !== "");

  const toStart = plan.services.filter((s) => s.skip === undefined);
  for (const s of plan.services) if (s.skip !== undefined) console.log(`demo · ${s.name} skipped: ${s.skip}`);
  for (const s of toStart) {
    if (s.port !== undefined && (await listening(s.port))) {
      throw new DemoConfigError(
        `port ${s.port} is in use, so the ${s.name} cannot start (is \`pnpm ${s.name === "dashboard" ? "dev" : s.name}\` already running?${s.name === "dashboard" ? " Set DASHBOARD_PORT to another port." : ""})`,
      );
    }
  }

  const children: { service: DemoService; child: ChildProcess }[] = [];
  let stopping = false;
  let tunnelUp = !toStart.some((s) => s.name === "tunnel");
  const stopAll = (signal: NodeJS.Signals = "SIGTERM"): void => {
    stopping = true;
    for (const { child } of children) if (child.exitCode === null) child.kill(signal);
  };

  const exited = new Promise<number>((resolve) => {
    let left = toStart.length;
    let code = 0;
    for (const service of toStart) {
      const child = spawn(service.command, [...service.args], { cwd: service.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      children.push({ service, child });
      for (const stream of [child.stdout!, child.stderr!]) {
        const redactor = createLineRedactor(secrets);
        const print = (lines: string[]): void => {
          for (const line of lines) {
            if (service.name === "tunnel" && isConnectedLine(line)) tunnelUp = true;
            console.log(`${service.name.padEnd(9)} | ${line}`);
          }
        };
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => print(redactor.push(chunk)));
        stream.on("end", () => print(redactor.flush()));
      }
      child.on("error", (e: NodeJS.ErrnoException) => {
        console.error(`demo · could not start the ${service.name} (${e.code ?? "unknown error"})`);
      });
      child.on("close", (exit) => {
        if (!stopping) {
          console.error(`demo · the ${service.name} exited (${exit ?? "signal"}); stopping the others`);
          code = exit ?? 1;
          stopAll();
        }
        if (--left === 0) resolve(code);
      });
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stopAll(signal));

  // Announce once every port answers and the tunnel has an edge connection.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const announce = async (): Promise<void> => {
    for (;;) {
      if (stopping) return;
      const ports = await Promise.all(toStart.filter((s) => s.port !== undefined).map((s) => listening(s.port!)));
      const ready = ports.every(Boolean) && tunnelUp;
      if (ready || Date.now() > deadline) {
        console.log(`\ndemo · ${ready ? "up" : "NOT all up after 60 s (see the lines above)"}`);
        for (const [label, url] of plan.urls) console.log(`  ${label.padEnd(40)} ${url}`);
        console.log(
          plan.liveReady
            ? "  live runs: `pnpm run:safe | run:permissive | run:budget`, or \"Run live\" in the dashboard (Docker must be running)"
            : "  replays only: a live run needs the collector, the registry and the tunnel (.env; otari-config/apply.md, sandbox/TUNNEL.md)",
        );
        console.log("  Ctrl-C stops everything.\n");
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  void announce();
  return exited;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof DemoConfigError ? `demo: ${e.message}` : "demo: unexpected failure");
    process.exit(2);
  },
);
