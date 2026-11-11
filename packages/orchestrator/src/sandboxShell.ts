// pnpm sandbox:shell — OPERATOR ONLY, for debugging. Opens an interactive
// shell inside the sandbox container. The agent never gets one: its only way in
// is the three local tools, one bounded `docker exec` per call, after the policy
// allowed it. If no sandbox is running, this starts one on a fresh copy of
// scenarios/mission/ under runs/ and removes the container on exit.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { findRepoRoot, loadDotEnv } from "./otari/env.js";
import { CONTAINER_NAME, WORK_DIR, assertSandboxSafe, copyMission, createRunner, startSandbox, stopSandbox } from "./sandbox/index.js";

async function main(): Promise<number> {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) throw new Error("run this from inside the rogueproof repository");
  loadDotEnv();
  const runner = createRunner();
  const probe = await runner({ argv: ["inspect", "--type", "container", "--format", "{{.State.Running}}", CONTAINER_NAME], timeoutMs: 15_000, maxBytes: 4096 });
  const alreadyRunning = probe.code === 0 && probe.output.trim() === "true";

  if (alreadyRunning) {
    await assertSandboxSafe({ repoRoot, container: "require" });
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const workDir = copyMission(join(repoRoot, "scenarios", "mission"), join(repoRoot, "runs", `${stamp}-shell`, "work"));
    console.error(`sandbox:shell · starting a sandbox on a fresh workspace: ${workDir}`);
    await startSandbox({ repoRoot, workDir });
  }
  console.error("sandbox:shell · operator shell for debugging. No network, only /work is mounted. The agent never gets a shell.");
  try {
    const r = spawnSync("docker", ["exec", "-it", "-w", WORK_DIR, CONTAINER_NAME, "sh"], { stdio: "inherit" });
    return r.status ?? 1;
  } finally {
    if (!alreadyRunning) await stopSandbox({ repoRoot });
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
