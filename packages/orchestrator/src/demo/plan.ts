// What `pnpm demo` starts (task 6.1): the honeypot, the collector (MCP), the report
// registry (MCP), the tunnel and the dashboard, each as its own child process running
// the same entry point as its own `pnpm` script. Pure: no process is started here.
//
// On a clean clone there is no .env, so the two MCP mocks (they need a bearer) and the
// tunnel (it needs a token and our hostnames) cannot start. They are skipped with a
// reason rather than failing the command: the honeypot and the dashboard are enough to
// watch the golden replays; a live run needs all five.
import { join } from "node:path";
import { COLLECTOR_PORT, HONEYPOT_PORT, REGISTRY_PORT, TunnelConfigError, publicUrls, readTunnelConfig } from "../tunnel/config.js";

export const DEFAULT_DASHBOARD_PORT = 3000;

export interface DemoService {
  readonly name: "honeypot" | "collector" | "registry" | "tunnel" | "dashboard";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Loopback port the service listens on; checked free before anything starts. The tunnel has none. */
  readonly port?: number;
  /** Set when the service cannot start with this environment; the reason names variables, never values. */
  readonly skip?: string;
}

export interface DemoPlan {
  readonly services: readonly DemoService[];
  /** What to print once everything is up. Public URLs are present only when the tunnel is configured. */
  readonly urls: readonly (readonly [label: string, url: string])[];
  /** True when every service a live run needs is in the plan. */
  readonly liveReady: boolean;
}

export class DemoConfigError extends Error {
  override readonly name = "DemoConfigError";
}

/** A port from the variable the service itself reads (HONEYPOT_PORT, COLLECTOR_PORT, REGISTRY_PORT), else its default. */
export function portFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new DemoConfigError(`${name} is not a valid port`);
  return value;
}

export function dashboardPort(env: NodeJS.ProcessEnv): number {
  return portFrom(env, "DASHBOARD_PORT", DEFAULT_DASHBOARD_PORT);
}

const missing = (env: NodeJS.ProcessEnv, name: string): boolean => (env[name] ?? "").trim() === "";

/** `env` is the process environment after .env was loaded. */
export function planDemo(repoRoot: string, env: NodeJS.ProcessEnv): DemoPlan {
  const node = process.execPath;
  const port = dashboardPort(env);
  // The tunnel's routes point at the default ports (Cloudflare dashboard): another port serves locally only.
  const honeypotPort = portFrom(env, "HONEYPOT_PORT", HONEYPOT_PORT);
  const collectorPort = portFrom(env, "COLLECTOR_PORT", COLLECTOR_PORT);
  const registryPort = portFrom(env, "REGISTRY_PORT", REGISTRY_PORT);
  const prefix = (() => {
    try {
      return publicUrls(readTunnelConfig({ ...env, TUNNEL_TOKEN: "x".repeat(32), HONEYPOT_PUBLIC_URL: "https://h.example.dev", COLLECTOR_PUBLIC_URL: "https://c.example.dev", REGISTRY_PUBLIC_URL: "" })).honeypot.replace("https://h.example.dev", "");
    } catch (e) {
      throw new DemoConfigError(e instanceof Error ? e.message : "HONEYPOT_PREFIX is not valid");
    }
  })();

  let tunnelSkip: string | undefined;
  let publicLines: (readonly [string, string])[] = [];
  try {
    const urls = publicUrls(readTunnelConfig(env));
    publicLines = [
      ["honeypot (public)", urls.honeypot],
      ["changelog (public)", urls.changelog],
      ["collector MCP (public, bearer required)", urls.collector],
      ...(urls.registry !== undefined ? [["registry MCP (public, bearer required)", urls.registry] as const] : []),
    ];
  } catch (e) {
    if (!(e instanceof TunnelConfigError)) throw e;
    tunnelSkip = `${e.message.replace(/ \(see sandbox\/TUNNEL\.md\)$/, "")}; no public URLs, so no live run (sandbox/TUNNEL.md)`;
  }

  const services: DemoService[] = [
    { name: "honeypot", command: node, args: [join(repoRoot, "scenarios", "honeypot", "dist", "main.js")], cwd: repoRoot, port: honeypotPort },
    {
      name: "collector",
      command: node,
      args: [join(repoRoot, "scenarios", "collector", "dist", "main.js")],
      cwd: repoRoot,
      port: collectorPort,
      ...(missing(env, "COLLECTOR_BEARER") ? { skip: "COLLECTOR_BEARER is not set" } : {}),
    },
    {
      name: "registry",
      command: node,
      args: [join(repoRoot, "scenarios", "registry", "dist", "main.js")],
      cwd: repoRoot,
      port: registryPort,
      ...(missing(env, "REGISTRY_BEARER") ? { skip: "REGISTRY_BEARER is not set" } : {}),
    },
    {
      name: "tunnel",
      command: node,
      args: [join(repoRoot, "packages", "orchestrator", "dist", "tunnel.js")],
      cwd: repoRoot,
      ...(tunnelSkip !== undefined ? { skip: tunnelSkip } : {}),
    },
    { name: "dashboard", command: "pnpm", args: ["exec", "next", "dev", "--port", String(port)], cwd: join(repoRoot, "apps", "dashboard"), port },
  ];

  return {
    services,
    urls: [
      ["dashboard", `http://localhost:${port}`],
      ["honeypot (local)", `http://localhost:${honeypotPort}${prefix}`],
      ...publicLines,
    ],
    liveReady:
      services.every((s) => s.skip === undefined) &&
      !missing(env, "REGISTRY_PUBLIC_URL") &&
      honeypotPort === HONEYPOT_PORT &&
      collectorPort === COLLECTOR_PORT &&
      registryPort === REGISTRY_PORT,
  };
}
