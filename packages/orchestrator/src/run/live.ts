// A scenario run started for the dashboard (task 5.2). The run itself is the
// same command as `pnpm run:<mode>`, in a child process: same checks, same
// refusals, same run directory. This module reads what that command prints
// (RunLog echoes every log.txt line, already scrubbed) and hands it on as
// messages: timeline events as they happen, then how the run ended. It stops
// the run after LIVE_TIMEOUT_MS, when the caller goes away, or when the sandbox
// container is no longer running, and takes the container down after any stop.
// One live run at a time: they share the sandbox container and the collector.
// Nothing here calls Otari, decides a block or changes an outcome.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import type { TimelineEvent } from "@rogueproof/shared";
import { PROFILES, findRepoRoot, type Profile } from "../otari/env.js";
import { redactString } from "../otari/redact.js";
import { CONTAINER_NAME, createRunner, stopSandbox } from "../sandbox/index.js";
import { isGuardrailBlock } from "../agent/events.js";
import { parseTimelineEvent } from "./replay.js";
import { SANDBOX_STOPPED_LINE, SANDBOX_UP_LINE } from "./scenario.js";

/** The modes a live run can be started in: the three policies of Defense Control. Never control, never --golden. */
export const LIVE_MODES = ["safe", "permissive", "budget"] as const;
export type LiveMode = (typeof LIVE_MODES)[number];
export const isLiveMode = (v: string): v is LiveMode => (LIVE_MODES as readonly string[]).includes(v);

/** A live run is stopped after four minutes. */
export const LIVE_TIMEOUT_MS = 4 * 60_000;
const KILL_GRACE_MS = 5_000;
const SANDBOX_POLL_MS = 2_000;
/** Consecutive probes that must miss before the container counts as gone: one failed `docker inspect` is not a dead sandbox. */
export const SANDBOX_MISSES = 2;
const LINE_MAX = 64 * 1024;
const TEXT_MAX = 300;

const SCRIPT: Record<LiveMode, string> = { safe: "runSafe.js", permissive: "runPermissive.js", budget: "runBudget.js" };

export type LiveMessage =
  /** `guardrailBlocked`: this is the event of a request Otari's guardrail refused (not one it flagged and served). */
  | { kind: "event"; event: TimelineEvent; guardrailBlocked: boolean }
  /** A log line of the run that is not a timeline event (checks passing, container up). */
  | { kind: "info"; text: string }
  /** The command finished and saved a run. `exitCode` 1: outcome `error`, or a Budget-limited run the budget did not stop. */
  | { kind: "end"; runDir: string; exitCode: number }
  /** No usable run: refused, crashed, timed out, sandbox gone, or another run in progress. */
  | { kind: "failed"; reason: string };

export type LiveLine = { kind: "event"; event: TimelineEvent; guardrailBlocked: boolean } | { kind: "info"; text: string } | { kind: "output"; runDir: string };

const clipText = (s: string): string => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);

/**
 * One line of the run command's stdout. Log lines are `<iso time>\t<kind>\t<text>`;
 * the command's last lines include `output: <run directory>`. Anything else is
 * not for the dashboard. External input: never throws.
 */
export function parseLiveLine(line: string): LiveLine | undefined {
  const parts = line.split("\t");
  if (parts.length >= 3) {
    const text = parts.slice(2).join("\t");
    if (parts[1] === "event") {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return undefined;
      }
      const event = parseTimelineEvent(raw);
      return event ? { kind: "event", event, guardrailBlocked: isGuardrailBlock(event) } : undefined;
    }
    if (parts[1] === "info" || parts[1] === "warn" || parts[1] === "error") return { kind: "info", text: clipText(redactString(text)) };
    return undefined;
  }
  if (line.startsWith("output: ") && line.length > "output: ".length) return { kind: "output", runDir: line.slice("output: ".length).trim() };
  return undefined;
}

/** What this module needs of a child process. */
export interface LiveChild {
  readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (e: Error) => void): unknown;
}

export interface LiveRunOptions {
  mode: LiveMode;
  /** Default: the repository the server's working directory is in. */
  repoRoot?: string;
  timeoutMs?: number;
  /** Aborting stops the run (the browser went away). */
  signal?: AbortSignal;
  /** Default: `node dist/run<Mode>.js` from the repo root, no flag. */
  spawn?: (mode: LiveMode, repoRoot: string) => LiveChild;
  /** Default: `docker inspect` says the sandbox container is running. */
  sandboxUp?: () => Promise<boolean>;
  /** Default: `docker compose down` on the sandbox. Called after a run this module had to stop. */
  stopSandbox?: () => Promise<void>;
  pollMs?: number;
  killGraceMs?: number;
}

function spawnRunCommand(mode: LiveMode, repoRoot: string): LiveChild {
  // Next to this file once built: dist/run/live.js → dist/runSafe.js.
  const script = fileURLToPath(new URL(`../${SCRIPT[mode]}`, import.meta.url));
  return spawn(process.execPath, [script], { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
}

async function dockerSandboxUp(): Promise<boolean> {
  const r = await createRunner()({ argv: ["inspect", "-f", "{{.State.Running}}", CONTAINER_NAME], timeoutMs: 10_000, maxBytes: 4096 });
  return r.spawnError === undefined && r.code === 0 && r.output.trim() === "true";
}

/**
 * MODEL_PROFILE as the run command will resolve it when it starts: the server's
 * own environment first, then <repo>/.env (read now, so an edit shows without a
 * restart), then `dev`. Null when the value is not a profile: the run would
 * refuse. Reads that one name and nothing else from the file.
 */
export function liveProfile(repoRoot: string | undefined = findRepoRoot(process.cwd()), env: NodeJS.ProcessEnv = process.env): Profile | null {
  let fromFile: string | undefined;
  if (repoRoot !== undefined) {
    try {
      fromFile = parseEnv(readFileSync(join(repoRoot, ".env"), "utf8"))["MODEL_PROFILE"];
    } catch {
      // No .env: the default applies, as it does for the run command.
    }
  }
  const raw = env["MODEL_PROFILE"] ?? fromFile ?? "dev";
  return (PROFILES as readonly string[]).includes(raw) ? (raw as Profile) : null;
}

let active = false;
/** True while a live run holds the sandbox. */
export const liveRunActive = (): boolean => active;

type Stop = "timeout" | "sandbox" | "abort";

/**
 * Starts `run:<mode>` and yields its messages as they arrive. Ends with exactly
 * one `end` or `failed`, except when the caller aborted (nobody is listening).
 * Returning early from the iteration stops the run.
 */
export async function* liveRun(o: LiveRunOptions): AsyncGenerator<LiveMessage, void, void> {
  const repoRoot = o.repoRoot ?? findRepoRoot(process.cwd());
  if (repoRoot === undefined) {
    yield { kind: "failed", reason: "the dashboard is not running inside the rogueproof repository" };
    return;
  }
  if (active) {
    yield { kind: "failed", reason: "another live run is in progress; wait for it to end" };
    return;
  }
  active = true;
  const timeoutMs = o.timeoutMs ?? LIVE_TIMEOUT_MS;
  const downSandbox = o.stopSandbox ?? (() => stopSandbox({ repoRoot }));
  const sandboxUp = o.sandboxUp ?? dockerSandboxUp;

  const queue: LiveMessage[] = [];
  let wake: (() => void) | undefined;
  const push = (m: LiveMessage): void => {
    queue.push(m);
    wake?.();
  };
  let exit: { code: number | null; spawnError?: string } | undefined;
  let stop: Stop | undefined;
  let runDir: string | undefined;
  let child: LiveChild | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let misses = 0;
  let errTail = "";

  const stopPolling = (): void => {
    if (poll) clearInterval(poll);
    poll = undefined;
  };
  const halt = (why: Stop): void => {
    if (stop !== undefined || exit !== undefined) return;
    stop = why;
    stopPolling();
    child?.kill("SIGTERM");
    killTimer = setTimeout(() => child?.kill("SIGKILL"), o.killGraceMs ?? KILL_GRACE_MS);
  };
  const onLine = (line: string): void => {
    if (stop !== undefined) return;
    const parsed = parseLiveLine(line);
    if (!parsed) return;
    if (parsed.kind === "output") {
      runDir = parsed.runDir;
      return;
    }
    if (parsed.kind === "info") {
      // The container is the run's only place to act: once it is up, a run without it is not a run.
      if (parsed.text.startsWith(SANDBOX_UP_LINE) && !poll) {
        poll = setInterval(() => {
          if (polling) return;
          polling = true;
          const probed = (up: boolean): void => {
            polling = false;
            misses = up ? 0 : misses + 1;
            if (misses >= SANDBOX_MISSES && poll) halt("sandbox");
          };
          sandboxUp().then(probed, () => probed(false));
        }, o.pollMs ?? SANDBOX_POLL_MS);
      } else if (parsed.text.startsWith(SANDBOX_STOPPED_LINE)) stopPolling();
    }
    push(parsed);
  };

  const timer = setTimeout(() => halt("timeout"), timeoutMs);
  const onAbort = (): void => halt("abort");
  o.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    try {
      child = (o.spawn ?? spawnRunCommand)(o.mode, repoRoot);
    } catch (e) {
      exit = { code: null, spawnError: e instanceof Error ? e.message : String(e) };
    }
    if (child) {
      let buf = "";
      child.stdout?.on("data", (chunk) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, nl).replace(/\r$/, ""));
          buf = buf.slice(nl + 1);
        }
        if (buf.length > LINE_MAX) buf = "";
      });
      child.stderr?.on("data", (chunk) => {
        errTail = (errTail + chunk.toString()).slice(-4096);
      });
      child.on("error", (e) => {
        exit ??= { code: null, spawnError: e.message };
        wake?.();
      });
      child.on("close", (code) => {
        if (buf !== "") onLine(buf);
        exit ??= { code };
        wake?.();
      });
      if (o.signal?.aborted) halt("abort");
    }

    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (exit !== undefined) break;
      await new Promise<void>((r) => (wake = r));
      wake = undefined;
    }

    if (stop !== undefined) {
      // The command was killed before its own `finally`: take the container down for it.
      await downSandbox().catch(() => undefined);
      if (stop === "timeout") yield { kind: "failed", reason: `the live run did not finish in ${Math.round(timeoutMs / 60_000)} minutes and was stopped` };
      else if (stop === "sandbox") yield { kind: "failed", reason: "the sandbox container stopped during the run; the run was stopped" };
      return;
    }
    if (exit.spawnError !== undefined) {
      yield { kind: "failed", reason: clipText(`the run command could not start: ${redactString(exit.spawnError)}`) };
    } else if (runDir !== undefined && (exit.code === 0 || exit.code === 1)) {
      yield { kind: "end", runDir, exitCode: exit.code };
    } else {
      // A refusal (exit 2) prints its reason as the last line of stderr.
      const last = errTail.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1);
      yield { kind: "failed", reason: clipText(redactString(last ?? `the run command exited with code ${exit.code ?? "none"}`)) };
    }
  } finally {
    clearTimeout(timer);
    stopPolling();
    o.signal?.removeEventListener("abort", onAbort);
    if (child && exit === undefined) {
      // The consumer left before the command ended: stop it and clean up without holding the caller.
      const c = child;
      c.kill("SIGTERM");
      const hard = setTimeout(() => c.kill("SIGKILL"), o.killGraceMs ?? KILL_GRACE_MS);
      c.on("close", () => {
        clearTimeout(hard);
        void downSandbox()
          .catch(() => undefined)
          .finally(() => (active = false));
      });
    } else {
      if (killTimer) clearTimeout(killTimer);
      active = false;
    }
  }
}
