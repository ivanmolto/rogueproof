// The per-run workspace copy and the container's lifecycle. A run never starts
// the container without the check passing before (compose file + workspace)
// and after (the running container) it comes up.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertSandboxSafe, type SandboxCheckResult } from "./check.js";
import { composeHostEnv, createRunner, type Runner } from "./exec.js";

export interface SandboxPaths {
  repoRoot: string;
  /** Default: <repo>/sandbox/docker-compose.yml. */
  composeFile?: string;
  runner?: Runner;
}

const composeFileOf = (p: SandboxPaths) => p.composeFile ?? join(p.repoRoot, "sandbox", "docker-compose.yml");

/**
 * Copies scenarios/mission/ to `destDir`, which must not exist yet: every run
 * gets a fresh workspace, and the committed directory is never mounted.
 */
export function copyMission(missionDir: string, destDir: string): string {
  if (existsSync(destDir)) throw new Error(`workspace ${destDir} already exists; a run needs a fresh copy`);
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(missionDir, destDir, { recursive: true, filter: (src) => basename(src) !== ".DS_Store" });
  return destDir;
}

const UP_TIMEOUT_MS = 10 * 60_000; // the first build pulls the base image
const DOWN_TIMEOUT_MS = 60_000;
const LOG_BYTES = 1024 * 1024;

/** Environment for `docker compose`: the bind source and the operator's uid. Nothing else is passed in. */
export function composeEnv(workDir: string): Record<string, string> {
  return {
    SANDBOX_WORK_DIR: workDir,
    SANDBOX_UID: String(process.getuid?.() ?? 1000),
    SANDBOX_GID: String(process.getgid?.() ?? 1000),
  };
}

/** Checks, builds and starts the container on `workDir`, then checks the running container. Throws on any finding. */
export async function startSandbox(p: SandboxPaths & { workDir: string }): Promise<SandboxCheckResult> {
  const run = p.runner ?? createRunner();
  const base = { repoRoot: p.repoRoot, composeFile: composeFileOf(p), workDir: p.workDir, runner: run };
  await assertSandboxSafe({ ...base, container: "skip" });
  const up = await run({
    argv: ["compose", "-f", composeFileOf(p), "up", "-d", "--build", "--force-recreate"],
    env: { ...(await composeHostEnv(run)), ...composeEnv(p.workDir) },
    timeoutMs: UP_TIMEOUT_MS,
    maxBytes: LOG_BYTES,
  });
  if (up.code !== 0) throw new Error(`could not start the sandbox: ${(up.spawnError ?? up.output).trim().slice(-600)}`);
  try {
    return await assertSandboxSafe({ ...base, container: "require" });
  } catch (e) {
    await stopSandbox(p);
    throw e;
  }
}

/** Stops and removes the container. Kills anything a tool call left running. */
export async function stopSandbox(p: SandboxPaths): Promise<void> {
  const run = p.runner ?? createRunner();
  await run({
    argv: ["compose", "-f", composeFileOf(p), "down", "--timeout", "2"],
    // `down` still interpolates the file; the value is not used.
    env: { ...(await composeHostEnv(run)), ...composeEnv(join(p.repoRoot, "scenarios", "mission")) },
    timeoutMs: DOWN_TIMEOUT_MS,
    maxBytes: LOG_BYTES,
  });
}
