// Task 5.2: the live run's SSE body and its wire format. Offline: the
// orchestrator's liveRun is replaced by a generator the test drives.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { TimelineEvent } from "@rogueproof/shared";
import { liveStream, sameOrigin, type LiveDeps } from "./live";
import { loadReplay } from "./runs";
import { createSseDecoder, encodeSse, parseWire, type LiveWire } from "./sse";
import { LIVE_CLIENT_TIMEOUT_MS, LIVE_MODE_KEYS, cardsAt, isFailedOutcome, isLiveModeKey, isModeKey, liveView, parseProfile, profileNote, statusText } from "./view";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN = join(ROOT, "runs", "golden");
const ev = (t: number, type: TimelineEvent["type"], summary: string, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({ t, type, summary, ...extra });

type Fed = import("@rogueproof/orchestrator").run.LiveMessage | null;

/** A liveRun the test feeds one message at a time (null ends it). Counts what was read from it and whether it reached its end. */
function feed() {
  const queue: Fed[] = [];
  let wake: (() => void) | undefined;
  let read = 0;
  let finished = false;
  const push = (m: Fed): void => {
    queue.push(m);
    wake?.();
  };
  const deps = (load: LiveDeps["load"]): LiveDeps => ({
    async *run() {
      for (;;) {
        while (queue.length > 0) {
          const m = queue.shift()!;
          if (m === null) {
            finished = true;
            return;
          }
          read++;
          yield m;
        }
        await new Promise<void>((r) => (wake = r));
      }
    },
    load,
  });
  return { push, deps, read: () => read, finished: () => finished };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<LiveWire[]> {
  const decoder = createSseDecoder();
  const out: LiveWire[] = [];
  const reader = stream.getReader();
  const text = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out.push(...decoder.push(text.decode(value, { stream: true })));
  }
}

describe("live stream", () => {
  it("sends each event as it happens, before the run has ended, then the saved run", async () => {
    const f = feed();
    const saved = await loadReplay("safe", GOLDEN);
    const reader = liveStream("safe", new AbortController().signal, f.deps(async () => ({ type: "end", view: saved }))).getReader();
    const decoder = createSseDecoder();
    const text = new TextDecoder();
    const next = async (): Promise<LiveWire[]> => decoder.push(text.decode((await reader.read()).value, { stream: true }));

    f.push({ kind: "info", text: "sandbox:check ok" });
    expect(await next()).toEqual([{ type: "info", text: "sandbox:check ok" }]);
    f.push({ kind: "event", event: ev(900, "fetch", "fetched https://honeypot.example/"), guardrailBlocked: false });
    // Read while the run is still open: the chunk is one complete SSE message.
    expect(await next()).toEqual([{ type: "timeline", event: ev(900, "fetch", "fetched https://honeypot.example/") }]);
    f.push({ kind: "event", event: ev(1500, "deny", "read_file .env — denied by safe policy (no-env)"), guardrailBlocked: false });
    expect((await next())[0]).toMatchObject({ type: "timeline", event: { type: "deny" } });
    // The orchestrator's label for a refused request travels with its event, and only then.
    f.push({ kind: "event", event: ev(1600, "guardrail", "any wording", { requestId: "r9" }), guardrailBlocked: true });
    expect(await next()).toEqual([{ type: "timeline", event: ev(1600, "guardrail", "any wording", { requestId: "r9" }), guardrailBlocked: true }]);

    f.push({ kind: "end", runDir: "/repo/runs/x", exitCode: 0 });
    f.push(null);
    const end = await next();
    expect(end[0]).toMatchObject({ type: "end", view: { runId: saved.runId, outcome: saved.outcome } });
    expect((await reader.read()).done).toBe(true);
  });

  it("ends on `failed` with the orchestrator's reason", async () => {
    const f = feed();
    const all = readAll(liveStream("safe", new AbortController().signal, f.deps(async () => { throw new Error("unused"); })));
    f.push({ kind: "event", event: ev(100, "fetch", "fetched x"), guardrailBlocked: false });
    f.push({ kind: "failed", reason: "the sandbox container stopped during the run; the run was stopped" });
    f.push(null);
    expect((await all).map((m) => m.type)).toEqual(["timeline", "failed"]);
  });

  it("fails when the saved run cannot be read, and when the run ends with nothing", async () => {
    const a = feed();
    const first = readAll(liveStream("safe", new AbortController().signal, a.deps(async () => { throw new Error("run.json is missing"); })));
    a.push({ kind: "end", runDir: "/nowhere", exitCode: 0 });
    a.push(null);
    expect(await first).toEqual([{ type: "failed", reason: "the run ended but its record could not be read: run.json is missing" }]);

    const b = feed();
    const second = readAll(liveStream("safe", new AbortController().signal, b.deps(async () => { throw new Error("unused"); })));
    b.push(null);
    expect(await second).toEqual([{ type: "failed", reason: "the run ended without a result" }]);
  });

  it("lets the run finish and save when the browser drops the stream", async () => {
    const f = feed();
    let loaded = "";
    const saved = await loadReplay("safe", GOLDEN);
    const reader = liveStream("safe", new AbortController().signal, f.deps(async (dir) => ((loaded = dir), { type: "end", view: saved }))).getReader();
    f.push({ kind: "info", text: "going" });
    await reader.read();
    await reader.cancel(); // the tab was closed or reloaded
    expect(f.finished()).toBe(false);
    // The run goes on with nobody listening: its messages are still read, to its end.
    f.push({ kind: "event", event: ev(100, "fetch", "fetched x"), guardrailBlocked: false });
    f.push({ kind: "end", runDir: "/repo/runs/x", exitCode: 0 });
    f.push(null);
    await vi.waitFor(() => expect(f.finished()).toBe(true));
    expect(f.read()).toBe(3);
    expect(loaded).toBe("/repo/runs/x");
  });

  it("lets the run finish when the request is aborted, and closes the stream", async () => {
    const f = feed();
    const request = new AbortController();
    const all = readAll(liveStream("safe", request.signal, f.deps(async () => { throw new Error("unused"); })));
    f.push({ kind: "info", text: "going" });
    await vi.waitFor(() => expect(f.read()).toBe(1));
    request.abort();
    f.push({ kind: "event", event: ev(100, "fetch", "fetched x"), guardrailBlocked: false });
    f.push({ kind: "failed", reason: "the live run did not finish in 4 minutes and was stopped" });
    f.push(null);
    await vi.waitFor(() => expect(f.finished()).toBe(true));
    expect(f.read()).toBe(3);
    // Whatever was already on its way may still arrive; the stream ends either way.
    expect((await all)[0]).toEqual({ type: "info", text: "going" });
  });

  it("starts nothing when the request is gone before the first read", async () => {
    const f = feed();
    const request = new AbortController();
    request.abort();
    f.push({ kind: "info", text: "never read" });
    const stream = liveStream("safe", request.signal, f.deps(async () => { throw new Error("unused"); }));
    expect(await readAll(stream)).toEqual([]);
    expect(f.read()).toBe(0);
  });
});

describe("who may start a live run", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it("accepts the page's own origin and requests that name none; refuses another site's", () => {
    expect(sameOrigin(h({ host: "localhost:3000", origin: "http://localhost:3000" }))).toBe(true);
    expect(sameOrigin(h({ host: "localhost:3000" }))).toBe(true);
    expect(sameOrigin(h({ host: "localhost:3000", origin: "https://evil.example" }))).toBe(false);
    expect(sameOrigin(h({ host: "localhost:3000", origin: "http://localhost:4000" }))).toBe(false);
    expect(sameOrigin(h({ host: "localhost:3000", origin: "null" }))).toBe(false);
  });
  it("knows the three modes and no other run", () => {
    expect(["safe", "permissive", "budget"].every(isModeKey)).toBe(true);
    expect(["control", "safe-fallback", "", "../safe"].some(isModeKey)).toBe(false);
  });
  it("starts live runs in Safe mode only", () => {
    expect(LIVE_MODE_KEYS).toEqual(["safe"]);
    expect(isLiveModeKey("safe")).toBe(true);
    expect(["permissive", "budget", "control", "safe-fallback", ""].some(isLiveModeKey)).toBe(false);
  });
});

describe("the profile shown before a live run", () => {
  it("says which models a run started now would use, and when it would refuse", () => {
    expect(profileNote("rubric")).toContain("open-weight models A/B/C");
    expect(profileNote("dev")).toContain("model D");
    expect(profileNote("dev")).toContain("not a rubric run");
    expect(profileNote(null)).toContain("refuse");
  });
  it("takes a profile from an API answer only when it is one", () => {
    expect([parseProfile("dev"), parseProfile("rubric"), parseProfile(null)]).toEqual(["dev", "rubric", null]);
    expect([parseProfile("golden"), parseProfile(undefined), parseProfile(1), parseProfile({})]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("SSE wire format", () => {
  const messages: LiveWire[] = [
    { type: "info", text: "collector cleared (0 drops)" },
    { type: "timeline", event: ev(10, "fetch", "fetched a\n\nb", { requestId: "req_1", cost: 0.0001 }) },
    { type: "failed", reason: "data: not a field\n\nevent: end" },
  ];

  it("round-trips whatever way the bytes are cut (fuzz)", () => {
    const text = messages.map(encodeSse).join("");
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 60 }), (cuts) => {
        const decoder = createSseDecoder();
        const out: LiveWire[] = [];
        let at = 0;
        for (const n of cuts) {
          out.push(...decoder.push(text.slice(at, at + n)));
          at += n;
        }
        out.push(...decoder.push(text.slice(at)));
        expect(out).toEqual(messages);
      }),
    );
  });

  it("never throws and only returns known messages, whatever arrives (fuzz)", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.string(), fc.json().map((j) => `data: ${j}\n\n`), fc.constantFrom("\n\n", "data:", "data: {\"type\":\"end\"}\n\n", "event: x\r\n\r\n"))), (chunks) => {
        const decoder = createSseDecoder();
        for (const c of chunks) for (const m of decoder.push(c)) expect(["timeline", "info", "end", "failed"]).toContain(m.type);
      }),
    );
  });

  it("drops messages that are not ours", () => {
    expect(parseWire({ type: "timeline", event: { t: "0", type: "fetch", summary: "x" } })).toBeUndefined();
    expect(parseWire({ type: "end", view: { events: "none" } })).toBeUndefined();
    expect(parseWire({ type: "failed" })).toBeUndefined();
    expect(parseWire(null)).toBeUndefined();
  });
});

describe("a live run on the cards", () => {
  const events = [
    ev(100, "fetch", "fetched x", { requestId: "r1", cost: 0.001, endUser: "safe-run-11" }),
    ev(200, "guardrail", "Otari inference guardrail flagged the request (injection, monitor mode); the request was served", { requestId: "r1" }),
    ev(300, "deny", "read_file .env — denied by safe policy (no-env)"),
    ev(400, "guardrail", "Otari guardrail blocked the request: prompt injection", { requestId: "r2" }),
  ];

  it("stays open while events arrive: never final, never an outcome", () => {
    const v = liveView("safe", events, ["r2"]);
    const c = cardsAt(v, events.length, true);
    expect(c.status).toBe("running");
    expect(statusText(c.status)).toBe("Running live…");
    expect(c.costIsFinal).toBe(false);
    expect(c.costUsd).toBe(0.001);
    expect([c.denied, c.guardrailBlocked, c.guardrailFlagged]).toEqual([1, 1, 1]);
    expect(v.endUser).toBe("safe-run-11");
    expect(cardsAt(liveView("budget", []), 0, true).status).toBe("running");
    // Without the orchestrator's label a guardrail event is a flag, whatever its text says.
    expect(cardsAt(liveView("safe", events), events.length, true)).toMatchObject({ guardrailBlocked: 0, guardrailFlagged: 2 });
  });

  it("a replay is unchanged by the new argument", async () => {
    const saved = await loadReplay("safe", GOLDEN);
    expect(cardsAt(saved, saved.events.length)).toEqual(cardsAt(saved, saved.events.length, false));
    expect(cardsAt(saved, saved.events.length).costIsFinal).toBe(true);
  });

  it("offers the replay for outcomes with no usable run, and waits longer than the server's four minutes", () => {
    expect(["error", "tool_error"].map((o) => isFailedOutcome(o as "error"))).toEqual([true, true]);
    expect(["ok", "fallback", "guardrail_blocked", "budget_exceeded", "step_cap"].some((o) => isFailedOutcome(o as "ok"))).toBe(false);
    expect(LIVE_CLIENT_TIMEOUT_MS).toBeGreaterThan(240_000);
  });
});
