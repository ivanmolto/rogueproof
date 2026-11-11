// Server-only: a live run for the page. The orchestrator starts `run:<mode>`,
// stops it after four minutes and reports how it ended; this turns its messages
// into the SSE body of POST /api/live/<mode>. The dashboard never calls Otari.
import { toView } from "./runs";
import { encodeSse, type LiveWire } from "./sse";
import type { LiveProfile, ModeKey } from "./view";

type Orchestrator = typeof import("@rogueproof/orchestrator");
type LiveMessage = import("@rogueproof/orchestrator").run.LiveMessage;
/** The built orchestrator, loaded by Node at run time and kept out of Next's bundle (see runs.ts). */
const orchestrator = (): Promise<Orchestrator> => import(/* webpackIgnore: true */ "@rogueproof/orchestrator");

/** MODEL_PROFILE as a run started now would resolve it (the orchestrator reads the environment and <repo>/.env; no key). */
export async function liveProfile(): Promise<LiveProfile> {
  const { run } = await orchestrator();
  return run.liveProfile();
}

/**
 * A live run spends credit, so only this page may start one: a request that
 * names an origin must name the host it was sent to. (A request with no Origin
 * header is not from a browser page.)
 */
export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === headers.get("host");
  } catch {
    return false;
  }
}

export interface LiveDeps {
  /** The orchestrator's liveRun for this mode. */
  run(): AsyncIterable<LiveMessage>;
  /** The saved run as the page shows it. */
  load(runDir: string): Promise<LiveWire>;
}

async function realDeps(mode: ModeKey): Promise<LiveDeps> {
  const { run } = await orchestrator();
  return {
    run: () => run.liveRun({ mode }),
    load: async (runDir) => {
      const r = run.replayDir(runDir);
      return { type: "end", view: toView(mode, r.record, r.timeline, r.problems) };
    },
  };
}

/** One wire message per orchestrator message; the saved run is read when the run ends. Never throws. */
export async function* liveWire(deps: LiveDeps): AsyncGenerator<LiveWire, void, void> {
  let closed = false;
  try {
    for await (const m of deps.run()) {
      if (m.kind === "event") yield { type: "timeline", event: m.event, ...(m.guardrailBlocked ? { guardrailBlocked: true as const } : {}) };
      else if (m.kind === "info") yield { type: "info", text: m.text };
      else if (m.kind === "failed") {
        closed = true;
        yield { type: "failed", reason: m.reason };
      } else {
        closed = true;
        try {
          yield await deps.load(m.runDir);
        } catch (e) {
          yield { type: "failed", reason: `the run ended but its record could not be read: ${e instanceof Error ? e.message : "unknown error"}` };
        }
      }
    }
    if (!closed) yield { type: "failed", reason: "the run ended without a result" };
  } catch (e) {
    yield { type: "failed", reason: e instanceof Error ? e.message : "the live run failed" };
  }
}

/**
 * The SSE body. When the browser goes away (the stream is cancelled, or
 * `signal`, the request's, aborts) the run is NOT stopped: its credit is
 * already being spent, so it runs on to its end and saves its run.json under
 * runs/, with nobody listening. The orchestrator still stops it at four
 * minutes or when the sandbox is gone, and refuses another live run meanwhile.
 */
export function liveStream(mode: ModeKey, signal: AbortSignal, deps?: LiveDeps): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let it: AsyncGenerator<LiveWire, void, void> | undefined;
  // A request that is already gone starts no run.
  let detached = signal.aborted;
  /** Reads the rest of the run and drops it, so the run reaches its end and frees the sandbox for the next one. */
  const detach = (): void => {
    if (detached) return;
    detached = true;
    signal.removeEventListener("abort", detach);
    const rest = it;
    if (!rest) return;
    void (async () => {
      try {
        while (!(await rest.next()).done);
      } catch {
        // Nobody is listening.
      }
    })();
  };
  signal.addEventListener("abort", detach, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Uint8Array | undefined;
      let last = detached;
      if (!last) {
        try {
          it ??= liveWire(deps ?? (await realDeps(mode)));
          const { value, done } = await it.next();
          if (done) last = true;
          else chunk = encoder.encode(encodeSse(value));
        } catch (e) {
          chunk = encoder.encode(encodeSse({ type: "failed", reason: e instanceof Error ? e.message : "the live run failed" }));
          last = true;
        }
      }
      try {
        if (chunk) controller.enqueue(chunk);
        if (last || detached) {
          signal.removeEventListener("abort", detach);
          controller.close();
        }
      } catch {
        // The browser left while this message was on its way.
      }
    },
    cancel: detach,
  });
}
