// sandbox:check. The pure checks run on data and are always offline. The suite
// that resolves the real compose file needs the docker CLI (not the daemon:
// `docker compose config` is client-side) and skips with a reason without it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  NETWORK_PROBE, SandboxCheckError, assertSandboxSafe, checkBindSource, checkCompose, checkContainer, checkInterfaces, checkSandbox,
  checkWorkspace, hostSecrets,
} from "./check.js";
import type { ExecRequest, ExecResult, Runner } from "./exec.js";
import { copyMission } from "./lifecycle.js";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const COMPOSE = join(ROOT, "sandbox", "docker-compose.yml");
const MISSION = join(ROOT, "scenarios", "mission");

const tmp = mkdtempSync(join(tmpdir(), "rp-sandbox-check-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = (files: Record<string, string>): string => {
  const d = join(tmp, `ws-${n++}`);
  mkdirSync(d, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(d, name, ".."), { recursive: true });
    writeFileSync(join(d, name), content);
  }
  return d;
};

/** What `docker compose config --format json` prints for sandbox/docker-compose.yml. */
const goodCompose = (): { services: { sandbox: Record<string, unknown> } } => ({
  services: {
    sandbox: {
      build: { context: "/repo/sandbox", dockerfile: "Dockerfile" },
      cap_drop: ["ALL"],
      command: ["sleep", "infinity"],
      container_name: "rogueproof-sandbox",
      entrypoint: null,
      image: "rogueproof-sandbox:local",
      init: true,
      mem_limit: "536870912",
      network_mode: "none",
      pids_limit: 256,
      read_only: true,
      security_opt: ["no-new-privileges:true"],
      tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=64m"],
      user: "1000:1000",
      volumes: [{ type: "bind", source: "/runs/x/work", target: "/work" }],
      working_dir: "/work",
    },
  },
});
const composeWith = (patch: Record<string, unknown>) => {
  const c = goodCompose();
  Object.assign(c.services.sandbox, patch);
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete c.services.sandbox[k];
  return c;
};
const details = (f: { detail: string }[]) => f.map((x) => x.detail).join("\n");

describe("checkCompose", () => {
  it("accepts the sandbox service", () => {
    expect(checkCompose(goodCompose())).toEqual([]);
  });

  it.each([
    ["a default network", { network_mode: undefined, networks: { default: null } }, /network_mode must be "none"/],
    ["bridge mode", { network_mode: "bridge" }, /network_mode must be "none"/],
    ["host mode", { network_mode: "host" }, /network_mode must be "none"/],
    ["a published port", { ports: [{ target: 80, published: "8080" }] }, /`ports`/],
    ["a second mount", { volumes: [{ type: "bind", source: "/x", target: "/work" }, { type: "bind", source: "/Users/me", target: "/host" }] }, /mount outside \/work/],
    ["the docker socket", { volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }] }, /mount outside \/work/],
    ["a named volume at /work", { volumes: [{ type: "volume", source: "data", target: "/work" }] }, /mount outside \/work/],
    ["no mount at all", { volumes: [] }, /exactly one volume/],
    ["a tmpfs elsewhere", { tmpfs: ["/tmp", "/root"] }, /tmpfs outside \/tmp: \/root/],
    ["an env_file", { env_file: [".env"] }, /`env_file`/],
    ["environment variables", { environment: { OTARI_API_KEY_AGENT: "x" } }, /`environment`/],
    ["privileged", { privileged: true }, /privileged/],
    ["added capabilities", { cap_add: ["NET_ADMIN"] }, /`cap_add`/],
    ["a writable root", { read_only: false }, /read_only/],
    ["kept capabilities", { cap_drop: [] }, /cap_drop/],
    ["the host pid namespace", { pid: "host" }, /`pid`/],
  ])("refuses %s", (_name, patch, message) => {
    const findings = checkCompose(composeWith(patch));
    expect(findings.length).toBeGreaterThan(0);
    expect(details(findings)).toMatch(message);
    expect(findings.every((f) => f.check === "compose")).toBe(true);
  });

  it("refuses extra or missing services and junk input", () => {
    const two = goodCompose() as { services: Record<string, unknown> };
    two.services["proxy"] = { image: "nginx" };
    expect(details(checkCompose(two))).toMatch(/exactly one service/);
    for (const junk of [undefined, null, 1, "x", [], {}, { services: [] }]) {
      expect(checkCompose(junk).length, JSON.stringify(junk)).toBeGreaterThan(0);
    }
  });
});

/** The relevant part of `docker inspect rogueproof-sandbox`. */
const goodInspect = (source = "/runs/x/work") => ({
  State: { Running: true },
  HostConfig: {
    NetworkMode: "none", Privileged: false, CapAdd: null, ReadonlyRootfs: true, PidMode: "", IpcMode: "private",
    UsernsMode: "", Devices: null, VolumesFrom: null, PortBindings: {}, Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=64m" },
  },
  Mounts: [{ Type: "bind", Source: source, Destination: "/work", RW: true }],
  NetworkSettings: { Ports: {}, Networks: { none: { IPAddress: "" } } },
  Config: { Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.21.1", "YARN_VERSION=1.22.22", "HOME=/tmp"] },
});

describe("checkContainer", () => {
  it("accepts the running sandbox", () => {
    expect(checkContainer(goodInspect())).toEqual([]);
    expect(checkContainer(goodInspect(), { expectedSource: "/runs/x/work" })).toEqual([]);
    expect(checkContainer(goodInspect("/host_mnt/runs/x/work"), { expectedSource: "/runs/x/work" })).toEqual([]);
  });

  it("refuses a container with a network", () => {
    const c = goodInspect();
    c.HostConfig.NetworkMode = "bridge";
    (c.NetworkSettings.Networks as Record<string, unknown>) = { bridge: { IPAddress: "172.17.0.2" } };
    expect(details(checkContainer(c))).toMatch(/has a network[\s\S]*attached to network\(s\): bridge/);
  });

  it("refuses a mount outside /work", () => {
    const c = goodInspect();
    c.Mounts.push({ Type: "bind", Source: "/Users/me", Destination: "/host", RW: true });
    expect(details(checkContainer(c))).toMatch(/mount outside \/work: "bind" at "\/host"/);
  });

  it("refuses a workspace that is not this run's", () => {
    expect(details(checkContainer(goodInspect("/somewhere/else"), { expectedSource: "/runs/x/work" }))).toMatch(/different directory/);
  });

  it("refuses unexpected environment and prints the name only", () => {
    const c = goodInspect();
    c.Config.Env.push("OTARI_API_KEY_AGENT=not-printed-value");
    const d = details(checkContainer(c));
    expect(d).toMatch(/unexpected environment variable in the container: OTARI_API_KEY_AGENT/);
    expect(d).not.toContain("not-printed-value");
  });

  it("refuses stopped, privileged, writable-root and junk containers", () => {
    const stopped = goodInspect();
    stopped.State.Running = false;
    expect(details(checkContainer(stopped))).toMatch(/not running/);
    const priv = goodInspect();
    priv.HostConfig.Privileged = true;
    priv.HostConfig.ReadonlyRootfs = false;
    expect(details(checkContainer(priv))).toMatch(/privileged[\s\S]*writable/);
    for (const junk of [undefined, null, {}, [], "x"]) expect(checkContainer(junk).length).toBeGreaterThan(0);
  });
});

const probe = (ifaces: string[], routes: string[] = []) => `${ifaces.join("\n")}\nROUTES\n${routes.join("\n")}${routes.length ? "\n" : ""}`;
const OFFLINE = probe(["lo 0x9"]);

describe("checkInterfaces", () => {
  it("accepts loopback only, and tunnel devices that are down", () => {
    expect(checkInterfaces(OFFLINE)).toEqual([]);
    // What Docker Desktop shows under network_mode none.
    expect(checkInterfaces(probe(["ip6tnl0 0x80", "lo 0x9", "tunl0 0x80"]))).toEqual([]);
  });

  it("refuses an interface that is up, or any route", () => {
    expect(details(checkInterfaces(probe(["eth0 0x1003", "lo 0x9"])))).toMatch(/interface\(s\) up besides loopback: eth0/);
    expect(details(checkInterfaces(probe(["lo 0x9", "tunl0 0x81"])))).toMatch(/up besides loopback: tunl0/);
    expect(details(checkInterfaces(probe(["lo 0x9"], ["eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0"])))).toMatch(/1 IPv4 route/);
  });

  it("fails closed on output it cannot read", () => {
    for (const junk of ["", "lo\n", "lo 0x9\n", "ROUTES\n", "eth0 up\nlo 0x9\nROUTES\n", "lo 0x9\nROUTES\nROUTES\n"]) {
      expect(checkInterfaces(junk).length, JSON.stringify(junk)).toBeGreaterThan(0);
    }
  });
});

describe("checkWorkspace", () => {
  it("accepts the committed mission", () => {
    expect(checkWorkspace(MISSION)).toEqual([]);
  });

  it("refuses a real-looking .env value without printing it", () => {
    const real = ["sk", "live", "9f8a7b6c5d4e3f2a1b0c"].join("-");
    const d = dir({ ".env": `FAKE_DEMO_OPENAI_KEY=sk-FAKE-DEMO-NOT-REAL\n# comment\n\nexport DB_PASSWORD="${real}"\n` });
    const findings = checkWorkspace(d);
    expect(findings).toEqual([{ check: "workspace", detail: ".env:4 DB_PASSWORD has a real-looking value (it does not contain FAKE)" }]);
    expect(details(findings)).not.toContain(real);
  });

  it("checks nested and variant .env files, and malformed lines", () => {
    const d = dir({ "config/.env.local": "A=FAKE-1\nB=\n", "prod.env": "C=hunter2\n", ".env": "not a pair\n", "notes.md": "TOKEN=whatever\n" });
    expect(checkWorkspace(d).map((f) => f.detail).sort()).toEqual([
      ".env:1 is not KEY=value",
      "config/.env.local:2 B has a real-looking value (it does not contain FAKE)",
      "prod.env:1 C has a real-looking value (it does not contain FAKE)",
    ]);
  });

  it("refuses a workspace that holds one of this machine's secrets, in any file", () => {
    const secret = "live-value-0123456789abcdef";
    const d = dir({ ".env": "A=FAKE\n", "REPORT.md": `leaked ${secret} here\n` });
    const found = checkWorkspace(d, { secrets: hostSecrets({ OTARI_API_KEY_AGENT: secret, HOME: "/Users/x", SHORT_KEY: "abc", FIXTURE_TOKEN: "FAKE-fixture-000000" }) });
    expect(found).toEqual([{ check: "workspace", detail: "REPORT.md contains the value of one of this machine's secret environment variables" }]);
  });

  it("refuses symbolic links and unreadable directories", () => {
    const d = dir({ ".env": "A=FAKE\n" });
    symlinkSync("/etc", join(d, "etc"));
    expect(details(checkWorkspace(d))).toMatch(/etc is a symbolic link/);
    expect(details(checkWorkspace(join(tmp, "does-not-exist")))).toMatch(/cannot read/);
  });
});

describe("checkBindSource", () => {
  const ctx = { repoRoot: ROOT, home: join(tmp, "home") };
  mkdirSync(ctx.home, { recursive: true });
  it("accepts a per-run copy and refuses the committed mission, the repo and the home", () => {
    expect(checkBindSource(join(ROOT, "runs", "x", "work"), ctx)).toEqual([]);
    expect(details(checkBindSource(MISSION, ctx))).toMatch(/not a per-run copy/);
    expect(details(checkBindSource(ROOT, ctx))).toMatch(/exposes the repository/);
    expect(details(checkBindSource(join(ROOT, ".."), ctx))).toMatch(/exposes the repository/);
    expect(details(checkBindSource(tmp, ctx))).toMatch(/host home/);
    expect(details(checkBindSource("/", ctx))).toMatch(/repository[\s\S]*host home/);
  });
});

describe("copyMission", () => {
  it("makes a fresh copy and refuses to reuse one", () => {
    const dest = join(tmp, "run-1", "work");
    copyMission(MISSION, dest);
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe(readFileSync(join(MISSION, ".env"), "utf8"));
    expect(checkWorkspace(dest)).toEqual([]);
    expect(() => copyMission(MISSION, dest)).toThrow(/fresh copy/);
  });
});

describe("checkSandbox with a scripted docker", () => {
  const ok = (output: string): ExecResult => ({ code: 0, output, timedOut: false, truncated: false });
  const fail = (output = ""): ExecResult => ({ code: 1, output, timedOut: false, truncated: false });
  const HOST = "unix:///fake/docker.sock";
  const scripted = (answers: { config?: ExecResult; inspect?: ExecResult; net?: ExecResult }): { runner: Runner; calls: ExecRequest[] } => {
    const calls: ExecRequest[] = [];
    return {
      calls,
      runner: async (req) => {
        // The one-off lookup of the docker endpoint (composeHostEnv) is not part of the check itself.
        if (req.argv[0] === "context") return ok(`${HOST}\n`);
        calls.push(req);
        if (req.argv[0] === "compose") return answers.config ?? ok(JSON.stringify(goodCompose()));
        if (req.argv[0] === "inspect") return answers.inspect ?? fail("Error: No such container");
        return answers.net ?? ok(OFFLINE);
      },
    };
  };
  const work = () => copyMission(MISSION, join(tmp, `live-${n++}`, "work"));

  it("passes statically and tells docker compose where the workspace is", async () => {
    const s = scripted({});
    const r = await checkSandbox({ repoRoot: ROOT, runner: s.runner, env: {} });
    expect(r).toMatchObject({ ok: true, findings: [] });
    expect(s.calls[0]?.argv).toEqual(["compose", "-f", COMPOSE, "config", "--format", "json"]);
    expect(s.calls[0]?.env).toEqual({ DOCKER_HOST: HOST, SANDBOX_WORK_DIR: MISSION });
  });

  it("skip mode never touches the container", async () => {
    const s = scripted({});
    await checkSandbox({ repoRoot: ROOT, runner: s.runner, env: {}, container: "skip" });
    expect(s.calls.map((c) => c.argv[0])).toEqual(["compose"]);
  });

  it("require mode fails without a container; assertSandboxSafe throws", async () => {
    const s = scripted({});
    const r = await checkSandbox({ repoRoot: ROOT, runner: s.runner, env: {}, container: "require" });
    expect(details(r.findings)).toMatch(/not found or Docker is unavailable/);
    await expect(assertSandboxSafe({ repoRoot: ROOT, runner: s.runner, env: {}, container: "require" })).rejects.toBeInstanceOf(SandboxCheckError);
  });

  it("passes on a running container bound to this run's workspace", async () => {
    const w = work();
    const s = scripted({ inspect: ok(JSON.stringify([goodInspect(w)])) });
    const r = await checkSandbox({ repoRoot: ROOT, runner: s.runner, env: {}, workDir: w, container: "require" });
    expect(r.findings).toEqual([]);
    expect(s.calls.at(-1)?.argv).toEqual(["exec", "rogueproof-sandbox", "sh", "-c", NETWORK_PROBE]);
  });

  it("fails on a running container with a network interface or a real secret in its mount", async () => {
    const w = work();
    writeFileSync(join(w, ".env"), "DB_PASSWORD=hunter2hunter2\n");
    const s = scripted({ inspect: ok(JSON.stringify([goodInspect(w)])), net: ok(probe(["eth0 0x1003", "lo 0x9"])) });
    const r = await checkSandbox({ repoRoot: ROOT, runner: s.runner, env: {} });
    expect(details(r.findings)).toMatch(/DB_PASSWORD has a real-looking value/);
    expect(details(r.findings)).toMatch(/up besides loopback: eth0/);
  });

  it("fails closed when docker compose cannot resolve the file", async () => {
    for (const config of [fail("yaml: line 3: mapping values are not allowed"), ok("not json"), { ...fail(), code: null, spawnError: "spawn docker ENOENT" }]) {
      const r = await checkSandbox({ repoRoot: ROOT, runner: scripted({ config }).runner, env: {}, container: "skip" });
      expect(details(r.findings)).toMatch(/could not resolve/);
    }
  });
});

const hasCompose = spawnSync("docker", ["compose", "version"]).status === 0;
if (!hasCompose) console.log("skipped: the docker CLI with the compose plugin is not installed, so sandbox/docker-compose.yml is not resolved here");

describe.skipIf(!hasCompose)("sandbox:check on sandbox/docker-compose.yml (docker CLI, no daemon)", () => {
  const check = (composeFile: string) => checkSandbox({ repoRoot: ROOT, composeFile, env: {}, container: "skip" });
  const modified = (name: string, edit: (yaml: string) => string): string => {
    const original = readFileSync(COMPOSE, "utf8");
    const edited = edit(original);
    expect(edited, "the edit must change the file").not.toBe(original);
    const file = join(tmp, name);
    writeFileSync(file, edited);
    return file;
  };

  it("passes on the committed compose file", async () => {
    const r = await check(COMPOSE);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails on a modified copy with a network", async () => {
    for (const replacement of ["networks: [default]", "network_mode: bridge", "network_mode: host"]) {
      const file = modified(`net-${n++}.yml`, (y) => y.replace("network_mode: none", replacement));
      const r = await check(file);
      expect(r.ok, replacement).toBe(false);
      expect(details(r.findings)).toMatch(/network_mode must be "none"/);
    }
  });

  it("fails on a modified copy with a second mount, an env_file or a published port", async () => {
    const mount = modified("mount.yml", (y) => y.replace("        target: /work\n", "        target: /work\n      - ${HOME}:/host:ro\n"));
    expect(details((await check(mount)).findings)).toMatch(/mount outside \/work/);
    const env = modified("env.yml", (y) => y.replace("    read_only: true\n", "    read_only: true\n    environment:\n      SOME_KEY: value\n"));
    expect(details((await check(env)).findings)).toMatch(/`environment`/);
    const ports = modified("ports.yml", (y) => y.replace("network_mode: none", 'ports: ["8080:80"]'));
    expect(details((await check(ports)).findings)).toMatch(/`ports`/);
  });
});
