/**
 * Local tool execution inside the no-egress sandbox container via
 * `docker exec`: read_file, write_file, run_command, each only after the
 * active policy allowed it. Plus the check every run must pass first
 * (`pnpm sandbox:check`). See ../../../../sandbox/README.md.
 */
export const MODULE = "sandbox" as const;
export {
  createDockerSandbox, resolveWorkPath,
  CONTAINER_NAME, WORK_DIR, COMMAND_TIMEOUT_S, OUTPUT_CAP_BYTES, WRITE_CAP_BYTES,
} from "./docker.js";
export type { DockerSandboxOptions, WorkPath } from "./docker.js";
export { composeHostEnv, createRunner } from "./exec.js";
export type { ExecRequest, ExecResult, Runner } from "./exec.js";
export {
  assertSandboxSafe, checkSandbox, checkCompose, checkContainer, checkInterfaces, checkWorkspace, checkBindSource,
  bindSourceOf, hostSecrets, NETWORK_PROBE, SandboxCheckError,
} from "./check.js";
export type { Finding, SandboxCheckOptions, SandboxCheckResult } from "./check.js";
export { copyMission, composeEnv, startSandbox, stopSandbox } from "./lifecycle.js";
export type { SandboxPaths } from "./lifecycle.js";
