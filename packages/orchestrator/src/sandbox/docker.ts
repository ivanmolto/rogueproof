// The agent's local tools, executed inside the sandbox container via
// `docker exec`. The loop calls these only after the tool policy allowed the
// call; nothing here decides whether an action is permitted. The agent never
// gets a shell of its own: every call is one bounded `docker exec`.
import { posix } from "node:path";
import type { Sandbox, ToolOutput } from "../agent/types.js";
import { createRunner, type ExecResult, type Runner } from "./exec.js";

export const CONTAINER_NAME = "rogueproof-sandbox";
export const WORK_DIR = "/work";
/** run_command is killed inside the container after this long. */
export const COMMAND_TIMEOUT_S = 30;
/** Cap on any tool's output, stdout and stderr together. */
export const OUTPUT_CAP_BYTES = 64 * 1024;
/** Cap on write_file content. The mission workspace is a handful of small files. */
export const WRITE_CAP_BYTES = 1024 * 1024;

/** `$1` is the timeout in seconds, `$2` the agent's command line. */
export const RUN_WRAPPER = 'exec 2>&1; exec timeout -k 2 "$1" sh -c "$2"';

const FILE_TIMEOUT_MS = 10_000;
/** Host-side backstop on top of the in-container timeout (TERM, then KILL after 2 s). */
const HOST_GRACE_MS = 5_000;

export interface DockerSandboxOptions {
  container?: string;
  runner?: Runner;
  /** Seconds; whole number. Overridable so tests need not wait 30 s. */
  commandTimeoutS?: number;
  outputCapBytes?: number;
}

export type WorkPath = { ok: true; path: string } | { ok: false; error: string };

/**
 * Maps a model-supplied path to an absolute path under /work. Model output is
 * data: never throws. This keeps read_file/write_file honest about "relative to
 * the workspace"; it is not the security boundary (the container is: no
 * network, no mount but /work, read-only root).
 */
export function resolveWorkPath(input: string): WorkPath {
  if (input.length === 0) return { ok: false, error: "path is empty" };
  if (input.includes("\0")) return { ok: false, error: "path contains a NUL byte" };
  if (input.length > 4096) return { ok: false, error: "path is too long" };
  const abs = posix.resolve(WORK_DIR, input);
  if (!abs.startsWith(`${WORK_DIR}/`)) return { ok: false, error: `path must be inside the workspace (${WORK_DIR})` };
  return { ok: true, path: abs };
}

const capNote = (cap: number) => `[output truncated at ${Math.round(cap / 1024)} KiB]`;

function unavailable(r: ExecResult): ToolOutput | undefined {
  if (r.spawnError !== undefined) return { ok: false, output: `sandbox unavailable: ${r.spawnError}` };
  return undefined;
}

export function createDockerSandbox(opts: DockerSandboxOptions = {}): Sandbox {
  const container = opts.container ?? CONTAINER_NAME;
  const run = opts.runner ?? createRunner();
  const timeoutS = opts.commandTimeoutS ?? COMMAND_TIMEOUT_S;
  const cap = opts.outputCapBytes ?? OUTPUT_CAP_BYTES;
  const exec = (...rest: string[]) => ["exec", "-w", WORK_DIR, container, ...rest];

  return {
    async readFile(path) {
      const p = resolveWorkPath(path);
      if (!p.ok) return { ok: false, output: p.error };
      const r = await run({ argv: exec("cat", "--", p.path), timeoutMs: FILE_TIMEOUT_MS, maxBytes: cap });
      const down = unavailable(r);
      if (down) return down;
      if (r.truncated) return { ok: true, output: `${r.output}\n${capNote(cap)}` };
      if (r.timedOut) return { ok: false, output: "read_file timed out" };
      return { ok: r.code === 0, output: r.output };
    },

    async writeFile(path, content) {
      const p = resolveWorkPath(path);
      if (!p.ok) return { ok: false, output: p.error };
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > WRITE_CAP_BYTES) return { ok: false, output: `content is ${bytes} bytes; the limit is ${WRITE_CAP_BYTES}` };
      // The path travels as an argument ($1), the content on stdin: neither is
      // ever part of the script text.
      const r = await run({
        argv: ["exec", "-i", "-w", WORK_DIR, container, "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", p.path],
        stdin: content,
        timeoutMs: FILE_TIMEOUT_MS,
        maxBytes: cap,
      });
      const down = unavailable(r);
      if (down) return down;
      if (r.timedOut) return { ok: false, output: "write_file timed out" };
      if (r.code !== 0) return { ok: false, output: r.output || `write failed (exit ${r.code})` };
      return { ok: true, output: `wrote ${bytes} bytes to ${p.path.slice(WORK_DIR.length + 1)}` };
    },

    async runCommand(cmd) {
      if (cmd.includes("\0")) return { ok: false, output: "command contains a NUL byte" };
      // `timeout` runs inside the container, so the process is killed there (a
      // killed `docker exec` client would leave it running). stderr is merged
      // into stdout in the container so the model sees output in the order it
      // was written. The wrapper script is a constant; the command is an
      // argument ($2) to the inner `sh -c`, and no host shell is involved.
      const r = await run({
        argv: exec("sh", "-c", RUN_WRAPPER, "sh", String(timeoutS), cmd),
        timeoutMs: timeoutS * 1000 + HOST_GRACE_MS,
        maxBytes: cap,
      });
      const down = unavailable(r);
      if (down) return down;
      const notes: string[] = [];
      if (r.truncated) notes.push(capNote(cap));
      // 124: timeout sent TERM; 137: it had to send KILL.
      const timedOut = r.timedOut || (!r.truncated && (r.code === 124 || r.code === 137));
      if (timedOut) notes.push(`[timed out after ${timeoutS} s]`);
      else if (!r.truncated && r.code !== 0) notes.push(`[exit ${r.code ?? "unknown"}]`);
      const body = r.output.length > 0 && notes.length > 0 && !r.output.endsWith("\n") ? `${r.output}\n` : r.output;
      return { ok: !timedOut && (r.truncated || r.code === 0), output: body + notes.join("\n") };
    },
  };
}
