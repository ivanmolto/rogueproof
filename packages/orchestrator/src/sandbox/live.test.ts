// [sandbox] Needs Docker: `pnpm test:sandbox`. Builds and starts the real
// container on a fresh copy of scenarios/mission/ and runs the local tools in it.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeSandbox } from "@rogueproof/testing";
import type { Sandbox } from "../agent/types.js";
import { NETWORK_PROBE, checkInterfaces, checkSandbox } from "./check.js";
import { CONTAINER_NAME, createDockerSandbox } from "./docker.js";
import { createRunner } from "./exec.js";
import { copyMission, startSandbox, stopSandbox } from "./lifecycle.js";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const MISSION = join(ROOT, "scenarios", "mission");

describeSandbox("local tools in the container", () => {
  // Under runs/ (gitignored): inside the repo, so Docker Desktop can share it.
  const runDir = join(ROOT, "runs", `test-sandbox-${process.pid}-${Date.now()}`);
  const workDir = join(runDir, "work");
  let sb: Sandbox;

  beforeAll(async () => {
    copyMission(MISSION, workDir);
    await startSandbox({ repoRoot: ROOT, workDir });
    sb = createDockerSandbox();
  }, 600_000);

  afterAll(async () => {
    await stopSandbox({ repoRoot: ROOT });
    rmSync(runDir, { recursive: true, force: true });
  }, 120_000);

  it("passes sandbox:check while running", async () => {
    const r = await checkSandbox({ repoRoot: ROOT, workDir, container: "require" });
    expect(r.findings).toEqual([]);
  });

  it("has no network: curl https://example.com fails", async () => {
    const curl = await sb.runCommand("curl -sS --max-time 5 https://example.com");
    expect(curl.ok).toBe(false);
    // The image ships no curl at all; with one, it would still have nowhere to go:
    const fetched = await sb.runCommand(
      `node -e "fetch('https://example.com').then(() => { console.log('REACHED'); }, (e) => { console.log('FETCH FAILED', e.cause && e.cause.code); process.exit(1); })"`,
    );
    expect(fetched.ok).toBe(false);
    expect(fetched.output).toContain("FETCH FAILED");
    expect(fetched.output).not.toContain("REACHED");
    // No route even to a literal address, and loopback is the only interface.
    const tcp = await sb.runCommand(
      `node -e "require('net').connect({ host: '1.1.1.1', port: 443, timeout: 3000 }).on('connect', () => { console.log('REACHED'); process.exit(0); }).on('error', (e) => { console.log('NO ROUTE', e.code); process.exit(1); }).on('timeout', () => process.exit(1))"`,
    );
    expect(tcp.ok).toBe(false);
    expect(tcp.output).not.toContain("REACHED");
    expect((await sb.runCommand("tail -n +2 /proc/net/route")).output.trim()).toBe("");
    expect(checkInterfaces((await sb.runCommand(NETWORK_PROBE)).output)).toEqual([]);
  });

  it("cannot see the host home or anything but the mission copy", async () => {
    const home = homedir();
    expect((await sb.runCommand(`test -e '${home}'`)).ok).toBe(false);
    expect((await sb.runCommand("test -e /Users || test -e /host_mnt")).ok).toBe(false);
    // /home holds the image's own unprivileged user and nothing from the host.
    expect((await sb.runCommand("ls -A /home")).output.trim()).toBe("node");
    expect((await sb.runCommand("ls -A /work")).output.trim().split("\n").sort()).toEqual([".env", "MISSION.md"]);
    // Bind mounts visible from inside: exactly /work.
    const mounts = await sb.runCommand(`grep -E ' (/work|/Users|/home|/host_mnt)' /proc/self/mountinfo | awk '{print $5}'`);
    expect(mounts.output.trim()).toBe("/work");
    // No host environment leaks in through docker exec.
    const env = (await sb.runCommand("env")).output;
    expect(env).not.toMatch(/OTARI|COLLECTOR|TUNNEL|otk_v1_|Bearer/i);
  });

  it("read_file reads the FAKE .env from the copy", async () => {
    const res = await sb.readFile(".env");
    expect(res).toEqual({ ok: true, output: readFileSync(join(MISSION, ".env"), "utf8") });
    expect((await sb.readFile("missing.txt")).ok).toBe(false);
  });

  it("write_file writes via stdin into the copy, never into scenarios/mission", async () => {
    const content = "# Report\n\n'quotes' \"double\" $(id) `id` \\n ünïcode\n";
    expect(await sb.writeFile("out/REPORT.md", content)).toEqual({ ok: true, output: `wrote ${Buffer.byteLength(content)} bytes to out/REPORT.md` });
    expect(await sb.readFile("out/REPORT.md")).toEqual({ ok: true, output: content });
    expect(readFileSync(join(workDir, "out", "REPORT.md"), "utf8")).toBe(content);
    expect(existsSync(join(MISSION, "out"))).toBe(false);
    expect(readdirSync(MISSION).filter((f) => f !== ".DS_Store").sort()).toEqual([".env", "MISSION.md", "README.md"]);
  });

  it("run_command runs in /work as an unprivileged user on a read-only root", async () => {
    expect((await sb.runCommand("pwd")).output.trim()).toBe("/work");
    expect((await sb.runCommand("id -u")).output.trim()).not.toBe("0");
    expect((await sb.runCommand("touch /usr/x || touch /etc/x")).ok).toBe(false);
    expect(await sb.runCommand("echo out; echo err >&2; exit 3")).toEqual({ ok: false, output: "out\nerr\n[exit 3]" });
    for (const tool of ["curl", "wget", "git", "ssh", "python3", "npm", "nc"]) {
      expect((await sb.runCommand(`command -v ${tool}`)).ok, tool).toBe(false);
    }
  });

  it("run_command is killed at the timeout, inside the container", async () => {
    const quick = createDockerSandbox({ commandTimeoutS: 2 });
    const started = Date.now();
    const res = await quick.runCommand("echo started; sleep 60; echo finished");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(res).toEqual({ ok: false, output: "started\n[timed out after 2 s]" });
    const left = await createRunner()({ argv: ["exec", CONTAINER_NAME, "sh", "-c", "cat /proc/[0-9]*/cmdline | tr '\\0' ' ' | grep -c '[s]leep 60' || true"], timeoutMs: 10_000, maxBytes: 4096 });
    expect(left.output.trim()).toBe("0");
  }, 30_000);

  it("run_command output is capped at 64 KiB", async () => {
    const res = await sb.runCommand("yes rogueproof | head -c 300000");
    expect(res.output.endsWith("[output truncated at 64 KiB]")).toBe(true);
    expect(Buffer.byteLength(res.output)).toBeLessThan(64 * 1024 + 64);
  });
});
