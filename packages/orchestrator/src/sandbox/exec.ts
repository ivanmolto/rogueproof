// One bounded child process. Everything the sandbox module runs (docker exec,
// docker compose, docker inspect) goes through a Runner, so unit tests inject a
// fake and never need Docker.
import { spawn } from "node:child_process";

export interface ExecRequest {
  /** Arguments after the binary. Passed as an argv array; never through a host shell. */
  argv: readonly string[];
  /** Written to the child's stdin, then stdin is closed. */
  stdin?: string;
  /** Host-side deadline. The child is killed when it passes. */
  timeoutMs: number;
  /** Cap on stdout + stderr together, in bytes. The child is killed when it is exceeded. */
  maxBytes: number;
  /** Extra environment for the child (the docker CLI), on top of the host's. */
  env?: Readonly<Record<string, string>>;
}

export interface ExecResult {
  /** Exit code; null when the child was killed or never started. */
  code: number | null;
  /** stdout and stderr interleaved in arrival order, cut at maxBytes. */
  output: string;
  timedOut: boolean;
  truncated: boolean;
  /** Set when the binary could not be started at all (e.g. docker is not installed). */
  spawnError?: string;
}

export type Runner = (req: ExecRequest) => Promise<ExecResult>;

/** A Runner that spawns `bin` (default `docker`). `bin` is injectable for tests. */
export function createRunner(bin = "docker"): Runner {
  return (req) =>
    new Promise<ExecResult>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      let truncated = false;
      let settled = false;
      const finish = (code: number | null, spawnError?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString("utf8");
        resolve(spawnError === undefined ? { code, output, timedOut, truncated } : { code, output, timedOut, truncated, spawnError });
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, [...req.argv], {
          stdio: ["pipe", "pipe", "pipe"],
          env: req.env ? { ...process.env, ...req.env } : process.env,
        });
      } catch (e) {
        // e.g. a NUL byte in an argument
        resolve({ code: null, output: "", timedOut: false, truncated: false, spawnError: e instanceof Error ? e.message : String(e) });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, req.timeoutMs);

      const onData = (b: Buffer) => {
        if (truncated) return;
        const room = req.maxBytes - size;
        if (b.length > room) {
          chunks.push(b.subarray(0, Math.max(room, 0)));
          size = req.maxBytes;
          truncated = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(b);
        size += b.length;
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", (e) => finish(null, e.message));
      child.on("close", (code) => finish(code));
      // A child that exits before reading stdin must not crash the orchestrator.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(req.stdin ?? "");
    });
}

const hostCache = new WeakMap<Runner, Promise<Record<string, string>>>();

/**
 * Environment for `docker compose` calls: the current context's endpoint as
 * DOCKER_HOST. Same daemon, same socket; it only stops compose from resolving
 * the named context itself, which costs a fixed 10 s per call with Docker
 * Desktop's `desktop-linux` context (compose 2.22; see sandbox/README.md).
 * Empty when DOCKER_HOST is already set or the context cannot be read.
 */
export function composeHostEnv(run: Runner, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  if (env["DOCKER_HOST"]) return Promise.resolve({});
  let cached = hostCache.get(run);
  if (!cached) {
    cached = run({ argv: ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], timeoutMs: 15_000, maxBytes: 4096 }).then((r) => {
      const host = r.output.trim();
      return r.code === 0 && /^(unix|tcp|ssh|npipe):\/\/\S+$/.test(host) ? { DOCKER_HOST: host } : {};
    });
    hostCache.set(run, cached);
  }
  return cached;
}
