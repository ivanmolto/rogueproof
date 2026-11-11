// `pnpm sandbox:check`: refuses a run if the sandbox has a network, a mount
// other than /work, or a real-looking secret in its workspace. Deterministic;
// no model is involved. It fails closed: anything it cannot read is a finding.
//
// Three things are inspected, each by a pure function over data:
//   compose    the file as `docker compose config` resolves it (what Docker would run)
//   container  `docker inspect` of the running container (what Docker is running)
//   workspace  the directory mounted at /work (what the agent can read)
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { CONTAINER_NAME, WORK_DIR } from "./docker.js";
import { composeHostEnv, createRunner, type Runner } from "./exec.js";

export interface Finding {
  check: "compose" | "container" | "workspace" | "mount";
  detail: string;
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const rec = (x: unknown): Rec => (isRec(x) ? x : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
/** True for undefined, null, [], {} and "". */
const empty = (x: unknown): boolean =>
  x === undefined || x === null || x === "" || (Array.isArray(x) ? x.length === 0 : isRec(x) && Object.keys(x).length === 0);

const SERVICE = "sandbox";
const TMPFS_ALLOWED = "/tmp";
/** Variables the image itself sets. Anything else in the container's environment is a finding. */
const ENV_ALLOWED = new Set(["PATH", "HOME", "NODE_VERSION", "YARN_VERSION"]);
/** Service keys that widen the sandbox; none may be set. */
const FORBIDDEN_KEYS = [
  "networks", "ports", "expose", "links", "external_links", "extra_hosts", "dns", "volumes_from", "devices",
  "cap_add", "env_file", "environment", "secrets", "configs", "pid", "ipc", "userns_mode", "cgroup_parent", "depends_on",
] as const;

const tmpfsTarget = (entry: unknown): string => (typeof entry === "string" ? (entry.split(":")[0] ?? "") : "?");

/** Checks the output of `docker compose -f <file> config --format json`. */
export function checkCompose(resolved: unknown): Finding[] {
  const out: Finding[] = [];
  const bad = (detail: string) => out.push({ check: "compose", detail });
  const services = rec(rec(resolved)["services"]);
  const names = Object.keys(services);
  if (names.length !== 1 || names[0] !== SERVICE) {
    bad(`expected exactly one service named "${SERVICE}", found: ${names.join(", ") || "none"}`);
  }
  if (!isRec(services[SERVICE])) return out;
  const s = services[SERVICE];

  if (s["network_mode"] !== "none") bad(`network_mode must be "none", found ${JSON.stringify(s["network_mode"] ?? null)}`);
  for (const key of FORBIDDEN_KEYS) {
    if (!empty(s[key])) bad(`service sets \`${key}\`, which the sandbox must not have`);
  }
  if (s["privileged"] === true) bad("service is privileged");
  if (s["read_only"] !== true) bad("root filesystem must be read_only");
  if (!arr(s["cap_drop"]).includes("ALL")) bad("cap_drop must include ALL");
  if (!arr(s["security_opt"]).includes("no-new-privileges:true")) bad("security_opt must include no-new-privileges:true");

  const volumes = arr(s["volumes"]);
  if (volumes.length !== 1) bad(`expected exactly one volume (the bind at ${WORK_DIR}), found ${volumes.length}`);
  for (const v of volumes) {
    const m = rec(v);
    if (m["type"] !== "bind" || m["target"] !== WORK_DIR) {
      bad(`mount outside ${WORK_DIR}: ${JSON.stringify(m["type"] ?? null)} at ${JSON.stringify(m["target"] ?? v)}`);
    }
  }
  for (const t of typeof s["tmpfs"] === "string" ? [s["tmpfs"]] : arr(s["tmpfs"])) {
    if (tmpfsTarget(t) !== TMPFS_ALLOWED) bad(`tmpfs outside ${TMPFS_ALLOWED}: ${tmpfsTarget(t)}`);
  }
  return out;
}

/** Docker Desktop may report a bind source under /host_mnt. */
const hostPath = (p: string): string => (p.startsWith("/host_mnt/") ? p.slice("/host_mnt".length) : p);
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The host directory bound at /work, when the inspect output has exactly that. */
export function bindSourceOf(inspect: unknown): string | undefined {
  const mounts = arr(rec(inspect)["Mounts"]).map(rec);
  const work = mounts.filter((m) => m["Destination"] === WORK_DIR && m["Type"] === "bind");
  return work.length === 1 && typeof work[0]?.["Source"] === "string" ? hostPath(work[0]["Source"]) : undefined;
}

/** Checks one element of `docker inspect <container>`. */
export function checkContainer(inspect: unknown, opts: { expectedSource?: string } = {}): Finding[] {
  const out: Finding[] = [];
  const bad = (detail: string) => out.push({ check: "container", detail });
  const c = rec(inspect);
  const host = rec(c["HostConfig"]);

  if (rec(c["State"])["Running"] !== true) bad("container is not running");
  if (host["NetworkMode"] !== "none") bad(`container has a network: NetworkMode is ${JSON.stringify(host["NetworkMode"] ?? null)}`);
  const networks = Object.keys(rec(rec(c["NetworkSettings"])["Networks"]));
  if (networks.some((n) => n !== "none")) bad(`container is attached to network(s): ${networks.join(", ")}`);
  if (!empty(rec(rec(c["NetworkSettings"])["Ports"])) || !empty(host["PortBindings"])) bad("container publishes ports");

  const mounts = arr(c["Mounts"]).map(rec);
  for (const m of mounts) {
    if (m["Destination"] !== WORK_DIR || m["Type"] !== "bind") {
      bad(`mount outside ${WORK_DIR}: ${JSON.stringify(m["Type"] ?? null)} at ${JSON.stringify(m["Destination"] ?? null)}`);
    }
  }
  const source = bindSourceOf(c);
  if (source === undefined) bad(`expected exactly one bind mount at ${WORK_DIR}`);
  else if (opts.expectedSource !== undefined && real(source) !== real(opts.expectedSource)) {
    bad(`${WORK_DIR} is bound to a different directory than this run's workspace`);
  }
  for (const t of Object.keys(rec(host["Tmpfs"]))) {
    if (t !== TMPFS_ALLOWED) bad(`tmpfs outside ${TMPFS_ALLOWED}: ${t}`);
  }

  if (host["Privileged"] === true) bad("container is privileged");
  if (!empty(host["CapAdd"])) bad("container adds capabilities");
  if (host["ReadonlyRootfs"] !== true) bad("root filesystem is writable");
  if (host["PidMode"] === "host" || host["IpcMode"] === "host" || host["UsernsMode"] === "host") bad("container shares a host namespace");
  if (!empty(host["Devices"])) bad("container has host devices");
  if (!empty(host["VolumesFrom"])) bad("container uses volumes_from");

  // Names only: a value could be a secret, and findings are printed.
  for (const e of arr(rec(c["Config"])["Env"])) {
    const name = typeof e === "string" ? (e.split("=")[0] ?? "") : "?";
    if (!ENV_ALLOWED.has(name)) bad(`unexpected environment variable in the container: ${name}`);
  }
  return out;
}

/**
 * Run inside the container (a constant script): every interface with its flags,
 * then the IPv4 routing table. There is no `ip` binary in the image.
 */
export const NETWORK_PROBE = 'for i in /sys/class/net/*; do echo "${i##*/} $(cat "$i/flags")"; done; echo ROUTES; tail -n +2 /proc/net/route';

/**
 * Checks the probe's output: loopback is the only interface that is up, and
 * there is no route. Interfaces that exist but are down are tolerated: some
 * kernels (Docker Desktop's among them) put inert tunnel devices such as
 * `tunl0` and `ip6tnl0` in every network namespace, `none` included. Anything
 * that does not parse is a finding.
 */
export function checkInterfaces(probeOutput: string): Finding[] {
  const out: Finding[] = [];
  const bad = (detail: string) => out.push({ check: "container", detail });
  const [ifacePart, routePart, ...rest] = probeOutput.split(/^ROUTES$/m);
  if (ifacePart === undefined || routePart === undefined || rest.length > 0) {
    return [{ check: "container", detail: "could not read the container's network interfaces" }];
  }
  const up: string[] = [];
  let sawLoopback = false;
  for (const line of ifacePart.split("\n").filter((l) => l.trim() !== "")) {
    const m = /^(\S+) (0x[0-9a-fA-F]+)$/.exec(line.trim());
    if (!m) {
      bad(`unreadable interface line: ${line.trim().slice(0, 80)}`);
      continue;
    }
    if (m[1] === "lo") sawLoopback = true;
    else if ((Number.parseInt(m[2] as string, 16) & 0x1) !== 0) up.push(m[1] as string); // IFF_UP
  }
  if (!sawLoopback) bad("could not read the container's network interfaces");
  if (up.length > 0) bad(`container has a network: interface(s) up besides loopback: ${up.join(", ")}`);
  const routes = routePart.split("\n").filter((l) => l.trim() !== "");
  if (routes.length > 0) bad(`container has a network: ${routes.length} IPv4 route(s)`);
  return out;
}

/** The directory bound at /work must be a per-run copy, never something that matters. */
export function checkBindSource(source: string, ctx: { repoRoot: string; home?: string }): Finding[] {
  const src = real(source);
  const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  const out: Finding[] = [];
  const bad = (detail: string) => out.push({ check: "mount", detail });
  const repo = real(ctx.repoRoot);
  const home = real(ctx.home ?? homedir());
  if (src === real(join(repo, "scenarios", "mission"))) bad("/work is the committed scenarios/mission, not a per-run copy");
  else if (within(repo, src)) bad("/work exposes the repository (the bind source contains it)");
  if (within(home, src)) bad("/work exposes the host home directory");
  return out;
}

const SECRET_ENV_NAME = /KEY|TOKEN|BEARER|SECRET|PASSWORD/i;
const MIN_SECRET_LENGTH = 12;

/** Values of the host's secret-looking variables, to make sure none was copied into the workspace. */
export function hostSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV_NAME.test(k) && typeof v === "string" && v.length >= MIN_SECRET_LENGTH && !v.includes("FAKE"))
    .map(([, v]) => v as string);
}

const MAX_ENTRIES = 2000;
const MAX_SCAN_BYTES = 1024 * 1024;
const isEnvFile = (name: string) => name === ".env" || name.startsWith(".env.") || name.endsWith(".env");

/**
 * Checks the workspace the agent will see: every value in every .env file
 * contains FAKE, and no file contains one of the host's own secrets. Findings
 * name the file, line and key, never the value.
 */
export function checkWorkspace(dir: string, opts: { secrets?: readonly string[] } = {}): Finding[] {
  const out: Finding[] = [];
  const bad = (detail: string) => out.push({ check: "workspace", detail });
  const secrets = opts.secrets ?? [];
  let seen = 0;

  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      bad(`cannot read ${relative(dir, d) || "the workspace directory"}`);
      return;
    }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) return;
      const p = join(d, name);
      const rel = relative(dir, p);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) bad(`${rel} is a symbolic link`);
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) scan(p, rel, name, st.size);
    }
  };

  const scan = (p: string, rel: string, name: string, size: number): void => {
    if (size > MAX_SCAN_BYTES) {
      bad(`${rel} is larger than ${MAX_SCAN_BYTES} bytes and was not scanned`);
      return;
    }
    const text = readFileSync(p, "utf8");
    if (secrets.some((s) => text.includes(s))) bad(`${rel} contains the value of one of this machine's secret environment variables`);
    if (!isEnvFile(name)) return;
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim().replace(/^export\s+/, "");
      if (line === "" || line.startsWith("#")) return;
      const eq = line.indexOf("=");
      if (eq <= 0) {
        bad(`${rel}:${i + 1} is not KEY=value`);
        return;
      }
      if (!line.slice(eq + 1).includes("FAKE")) {
        bad(`${rel}:${i + 1} ${line.slice(0, eq).trim().slice(0, 60)} has a real-looking value (it does not contain FAKE)`);
      }
    });
  };

  walk(dir);
  if (seen > MAX_ENTRIES) bad(`workspace has more than ${MAX_ENTRIES} entries`);
  return out;
}

export interface SandboxCheckOptions {
  repoRoot: string;
  /** Default: <repo>/sandbox/docker-compose.yml. */
  composeFile?: string;
  /** The per-run copy that is (or will be) bound at /work. Without it, only scenarios/mission is scanned. */
  workDir?: string;
  /**
   * `require`: the container must be running and pass (what every run uses once it is up).
   * `if-running`: inspect it when it exists (the default; `pnpm sandbox:check`).
   * `skip`: compose file and workspace only (before the container is started).
   */
  container?: "require" | "if-running" | "skip";
  containerName?: string;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface SandboxCheckResult {
  ok: boolean;
  findings: Finding[];
  /** What was actually inspected, for the operator. */
  checked: string[];
}

const DOCKER_TIMEOUT_MS = 30_000;
const DOCKER_MAX_BYTES = 4 * 1024 * 1024;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function checkSandbox(o: SandboxCheckOptions): Promise<SandboxCheckResult> {
  const run = o.runner ?? createRunner();
  const mode = o.container ?? "if-running";
  const name = o.containerName ?? CONTAINER_NAME;
  const composeFile = o.composeFile ?? join(o.repoRoot, "sandbox", "docker-compose.yml");
  const missionDir = join(o.repoRoot, "scenarios", "mission");
  const secrets = hostSecrets(o.env);
  const ctx = o.home === undefined ? { repoRoot: o.repoRoot } : { repoRoot: o.repoRoot, home: o.home };
  const findings: Finding[] = [];
  const checked: string[] = [];
  const docker = (argv: string[], env?: Record<string, string>) =>
    run({ argv, timeoutMs: DOCKER_TIMEOUT_MS, maxBytes: DOCKER_MAX_BYTES, ...(env ? { env } : {}) });

  // 1. The compose file, as Docker resolves it.
  const cfg = await docker(["compose", "-f", composeFile, "config", "--format", "json"], {
    ...(await composeHostEnv(run)),
    SANDBOX_WORK_DIR: o.workDir ?? missionDir,
  });
  const resolved = cfg.code === 0 ? parseJson(cfg.output) : undefined;
  if (resolved === undefined) {
    findings.push({ check: "compose", detail: `could not resolve ${composeFile} with \`docker compose config\`: ${(cfg.spawnError ?? cfg.output).trim().slice(0, 300)}` });
  } else {
    findings.push(...checkCompose(resolved));
    checked.push(`compose file ${composeFile}`);
  }

  // 2. The workspace.
  const scanned = new Set<string>();
  const scanDir = (dir: string, isBindSource: boolean) => {
    if (scanned.has(real(dir))) return;
    scanned.add(real(dir));
    findings.push(...checkWorkspace(dir, { secrets }));
    if (isBindSource) findings.push(...checkBindSource(dir, ctx));
    checked.push(`workspace ${dir}`);
  };
  if (o.workDir !== undefined) scanDir(o.workDir, true);
  else scanDir(missionDir, false);

  // 3. The container, when there is one.
  if (mode !== "skip") {
    const ins = await docker(["inspect", "--type", "container", name]);
    const parsed = ins.code === 0 ? arr(parseJson(ins.output))[0] : undefined;
    if (parsed === undefined) {
      if (mode === "require") findings.push({ check: "container", detail: `container ${name} not found or Docker is unavailable` });
      else checked.push(`container ${name}: not running (nothing to inspect)`);
    } else {
      findings.push(...checkContainer(parsed, o.workDir === undefined ? {} : { expectedSource: o.workDir }));
      const source = bindSourceOf(parsed);
      if (source !== undefined) scanDir(source, true);
      const net = await docker(["exec", name, "sh", "-c", NETWORK_PROBE]);
      if (net.code !== 0) findings.push({ check: "container", detail: "could not read the container's network interfaces" });
      else findings.push(...checkInterfaces(net.output));
      checked.push(`container ${name}`);
    }
  }
  return { ok: findings.length === 0, findings, checked };
}

export class SandboxCheckError extends Error {
  constructor(readonly findings: readonly Finding[]) {
    super(`sandbox:check failed, refusing to run:\n${findings.map((f) => `  - [${f.check}] ${f.detail}`).join("\n")}`);
    this.name = "SandboxCheckError";
  }
}

/** What every `run:*` script calls. Throws unless the sandbox passes. */
export async function assertSandboxSafe(o: SandboxCheckOptions): Promise<SandboxCheckResult> {
  const r = await checkSandbox(o);
  if (!r.ok) throw new SandboxCheckError(r.findings);
  return r;
}
