// Task 5.2: a run started for the dashboard. Offline: the run command is a fake
// child process, the sandbox probe and `compose down` are injected.
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { LIVE_TIMEOUT_MS, liveProfile, liveRun, liveRunActive, parseLiveLine, type LiveChild, type LiveMessage } from "./live.js";
import { guardrailBlockEvent, guardrailFlaggedEvent } from "../agent/events.js";
import { GUARDRAILS_HEADER } from "../otari/guardrails.js";
import { SANDBOX_STOPPED_LINE, SANDBOX_UP_LINE } from "./scenario.js";

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  /** When false the child ignores SIGTERM, as a hung process would. */
  diesOnTerm = true;
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.diesOnTerm) queueMicrotask(() => this.emit("close", null));
    return true;
  }
  out(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }
  err(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }
  exit(code: number): void {
    this.emit("close", code);
  }
}

const T = "2026-11-11T10:00:00.000Z";
const eventLine = (t: number, type: string, summary: string): string => `${T}\tevent\t${JSON.stringify({ t, type, summary, requestId: `req_${t}` })}\n`;
const infoLine = (text: string): string => `${T}\tinfo\t${text}\n`;

function start(opts: Partial<Parameters<typeof liveRun>[0]> = {}) {
  const child = new FakeChild();
  let downs = 0;
  const it = liveRun({
    mode: "safe",
    repoRoot: "/repo",
    spawn: () => child as unknown as LiveChild,
    sandboxUp: async () => true,
    stopSandbox: async () => void downs++,
    pollMs: 5,
    killGraceMs: 20,
    ...opts,
  });
  return { child, it, downs: () => downs };
}

async function drain(it: AsyncGenerator<LiveMessage>): Promise<LiveMessage[]> {
  const out: LiveMessage[] = [];
  for await (const m of it) out.push(m);
  return out;
}

describe("parseLiveLine", () => {
  it("reads event, info and output lines and nothing else", () => {
    expect(parseLiveLine(eventLine(1200, "fetch", "fetched https://honeypot.example/").trimEnd())).toEqual({
      kind: "event",
      event: { t: 1200, type: "fetch", summary: "fetched https://honeypot.example/", requestId: "req_1200" },
      guardrailBlocked: false,
    });
    expect(parseLiveLine(`${T}\tinfo\tcollector cleared (0 drops)`)).toEqual({ kind: "info", text: "collector cleared (0 drops)" });
    expect(parseLiveLine("output: /repo/runs/2026-safe")).toEqual({ kind: "output", runDir: "/repo/runs/2026-safe" });
    expect(parseLiveLine("run:safe · outcome ok · 9 model calls")).toBeUndefined();
    expect(parseLiveLine(`${T}\tevent\t{not json`)).toBeUndefined();
    expect(parseLiveLine(`${T}\tevent\t${JSON.stringify({ t: 1, type: "shell", summary: "x" })}`)).toBeUndefined();
  });

  it("marks a request Otari's guardrail refused, and not one it flagged and served", () => {
    const line = (e: { type: string; summary: string }): string => `${T}\tevent\t${JSON.stringify({ t: 5, ...e, requestId: "req_5" })}`;
    const flagged = guardrailFlaggedEvent("ok", { [GUARDRAILS_HEADER]: JSON.stringify([{ profile: "injection", mode: "monitor", valid: false, score: 1 }]) });
    expect(parseLiveLine(line(guardrailBlockEvent("prompt injection")))).toMatchObject({ kind: "event", guardrailBlocked: true });
    expect(parseLiveLine(line(guardrailBlockEvent(undefined)))).toMatchObject({ guardrailBlocked: true });
    if (flagged) expect(parseLiveLine(line(flagged))).toMatchObject({ kind: "event", guardrailBlocked: false });
    expect(parseLiveLine(line({ type: "deny", summary: guardrailBlockEvent("x").summary }))).toMatchObject({ guardrailBlocked: false });
  });

  it("never passes a key or a bearer token on", () => {
    const line = parseLiveLine(`${T}\terror\tgateway said otk_v1_eu_FAKEabcdef123456 and Authorization: Bearer FAKEabcdefgh12345678`);
    expect(line?.kind).toBe("info");
    const text = JSON.stringify(line);
    expect(text).not.toMatch(/otk_v1_|\btk-|\bgw_|Bearer\s+[A-Za-z0-9]/);
  });

  it("never throws, whatever the line (fuzz)", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.tuple(fc.string(), fc.constantFrom("event", "info", "warn", "x"), fc.string()).map((p) => p.join("\t"))), (line) => {
        const r = parseLiveLine(line);
        expect(r === undefined || ["event", "info", "output"].includes(r.kind)).toBe(true);
      }),
    );
  });
});

describe("liveRun", () => {
  it("has a four-minute timeout", () => {
    expect(LIVE_TIMEOUT_MS).toBe(240_000);
  });

  it("yields each event while the run is still going, then the saved run", async () => {
    const { child, it: run, downs } = start();
    const first = run.next();
    child.out(infoLine("sandbox:check ok"));
    expect((await first).value).toEqual({ kind: "info", text: "sandbox:check ok" });
    // An event split across two chunks arrives once its line is complete; the child has not exited.
    const line = eventLine(900, "fetch", "fetched https://honeypot.example/");
    const second = run.next();
    child.out(line.slice(0, 30));
    child.out(line.slice(30) + eventLine(1500, "deny", "read_file .env — denied by safe policy (no-env)"));
    expect((await second).value).toMatchObject({ kind: "event", event: { type: "fetch", t: 900 } });
    expect((await run.next()).value).toMatchObject({ kind: "event", event: { type: "deny" } });
    expect(child.signals).toEqual([]);
    expect(liveRunActive()).toBe(true);

    child.out("\nrun:safe · outcome ok\noutput: /repo/runs/2026-safe\n");
    child.exit(0);
    expect(await drain(run)).toEqual([{ kind: "end", runDir: "/repo/runs/2026-safe", exitCode: 0 }]);
    expect(downs()).toBe(0);
    expect(liveRunActive()).toBe(false);
  });

  it("reports a refusal with the command's own reason, redacted", async () => {
    const { child, it: run } = start();
    const all = drain(run);
    child.out(infoLine("run x · mode safe"));
    child.err("the honeypot is not reachable at its public URL (Bearer FAKEabcdefgh12345678)\n");
    child.exit(2);
    const msgs = await all;
    expect(msgs.at(-1)).toEqual({ kind: "failed", reason: "the honeypot is not reachable at its public URL ([REDACTED])" });
    expect(liveRunActive()).toBe(false);
  });

  it("fails when the command exits without a saved run", async () => {
    const { child, it: run } = start();
    const all = drain(run);
    child.exit(0);
    expect(await all).toEqual([{ kind: "failed", reason: "the run command exited with code 0" }]);
  });

  it("stops the run at the timeout, kills a child that ignores SIGTERM, and takes the sandbox down", async () => {
    const { child, it: run, downs } = start({ timeoutMs: 30 });
    child.diesOnTerm = false;
    const all = drain(run);
    child.out(eventLine(100, "fetch", "fetched x"));
    const msgs = await all;
    expect(msgs.map((m) => m.kind)).toEqual(["event", "failed"]);
    expect(msgs.at(-1)).toMatchObject({ reason: expect.stringContaining("did not finish") });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(downs()).toBe(1);
    expect(liveRunActive()).toBe(false);
  });

  it("fails the run when the sandbox container is killed under it", async () => {
    let up = true;
    const { child, it: run, downs } = start({ sandboxUp: async () => up });
    const all = drain(run);
    child.out(infoLine(`${SANDBOX_UP_LINE} (no network, /work only)`) + eventLine(100, "read", "read_file MISSION.md"));
    await new Promise((r) => setTimeout(r, 25));
    expect(child.signals).toEqual([]);
    up = false; // docker kill rogueproof-sandbox
    const msgs = await all;
    expect(msgs.at(-1)).toEqual({ kind: "failed", reason: "the sandbox container stopped during the run; the run was stopped" });
    expect(child.signals[0]).toBe("SIGTERM");
    expect(downs()).toBe(1);
  });

  it("keeps the run when a single sandbox probe misses", async () => {
    const answers = [true, false, true, false, true];
    let probes = 0;
    const { child, it: run, downs } = start({ sandboxUp: async () => answers[probes++] ?? true });
    const all = drain(run);
    child.out(infoLine(`${SANDBOX_UP_LINE} (no network, /work only)`));
    // Wait for the probes themselves, not for a length of time: the suite runs under load.
    await vi.waitFor(() => expect(probes).toBeGreaterThanOrEqual(5), { timeout: 5_000, interval: 5 });
    expect(child.signals).toEqual([]);
    child.out(infoLine(SANDBOX_STOPPED_LINE) + "output: /repo/runs/r\n");
    child.exit(0);
    expect((await all).at(-1)).toEqual({ kind: "end", runDir: "/repo/runs/r", exitCode: 0 });
    expect(downs()).toBe(0);
  });

  it("does not watch the sandbox before it is up or after the run stopped it", async () => {
    let probes = 0;
    const { child, it: run } = start({ sandboxUp: async () => (probes++, false) });
    const all = drain(run);
    child.out(infoLine("sandbox:check ok"));
    await new Promise((r) => setTimeout(r, 20));
    expect(probes).toBe(0);
    child.out(infoLine(`${SANDBOX_UP_LINE} (no network, /work only)`) + infoLine(SANDBOX_STOPPED_LINE));
    await new Promise((r) => setTimeout(r, 20));
    expect(probes).toBe(0);
    child.out("output: /repo/runs/r\n");
    child.exit(0);
    expect((await all).at(-1)).toMatchObject({ kind: "end" });
  });

  it("stops the run when the caller aborts, with no final message", async () => {
    const ac = new AbortController();
    const { child, it: run, downs } = start({ signal: ac.signal });
    const all = drain(run);
    child.out(eventLine(100, "fetch", "fetched x"));
    ac.abort();
    expect((await all).map((m) => m.kind)).toEqual(["event"]);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(downs()).toBe(1);
    expect(liveRunActive()).toBe(false);
  });

  it("refuses a second run while one is in progress", async () => {
    const a = start();
    const first = a.it.next();
    a.child.out(infoLine("going"));
    await first;
    const b = start();
    expect(await drain(b.it)).toEqual([{ kind: "failed", reason: "another live run is in progress; wait for it to end" }]);
    a.child.out("output: /repo/runs/r\n");
    a.child.exit(0);
    await drain(a.it);
    expect(liveRunActive()).toBe(false);
  });

  it("fails when the command cannot be started", async () => {
    const run = liveRun({ mode: "safe", repoRoot: "/repo", spawn: () => { throw new Error("spawn ENOENT"); }, stopSandbox: async () => {} });
    expect(await drain(run)).toEqual([{ kind: "failed", reason: "the run command could not start: spawn ENOENT" }]);
    expect(liveRunActive()).toBe(false);
  });
});

describe("liveRun outside the repository", () => {
  it("finds the repository from the working directory, and fails without one", async () => {
    const cwd = process.cwd();
    try {
      process.chdir("/");
      expect(await drain(liveRun({ mode: "safe", spawn: () => { throw new Error("not reached"); } }))).toEqual([
        { kind: "failed", reason: "the dashboard is not running inside the rogueproof repository" },
      ]);
    } finally {
      process.chdir(cwd);
    }
    let seen = "";
    await drain(liveRun({ mode: "safe", spawn: (_m, root) => { seen = root; throw new Error("stop here"); } }));
    expect(seen).toBe(cwd);
  });
});

describe("liveProfile", () => {
  const repo = (dotenv?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "rogueproof-profile-"));
    if (dotenv !== undefined) writeFileSync(join(dir, ".env"), dotenv);
    return dir;
  };

  it("resolves as the run command does: environment, then .env, then dev", () => {
    expect(liveProfile(repo("OTARI_BASE_URL=https://x.example\nMODEL_PROFILE=rubric\n"), {})).toBe("rubric");
    expect(liveProfile(repo("MODEL_PROFILE=rubric\n"), { MODEL_PROFILE: "dev" })).toBe("dev");
    expect(liveProfile(repo("# nothing here\n"), {})).toBe("dev");
    expect(liveProfile(repo(), {})).toBe("dev");
  });

  it("is null for a value the run would refuse", () => {
    expect(liveProfile(repo("MODEL_PROFILE=golden\n"), {})).toBeNull();
    expect(liveProfile(repo("MODEL_PROFILE=rubric\n"), { MODEL_PROFILE: "" })).toBeNull();
  });
});
