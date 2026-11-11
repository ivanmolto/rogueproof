// The live run's wire format between POST /api/live/<mode> and the page:
// server-sent events, one JSON message per event. Pure: no I/O, used on both
// sides. The decoder treats the stream as external input and never throws.
import type { TimelineEvent } from "@rogueproof/shared";
import type { ReplayView } from "./view";

export type LiveWire =
  /** One timeline event, as the run emitted it. `guardrailBlocked` (the orchestrator's label): a request Otari's guardrail refused. */
  | { type: "timeline"; event: TimelineEvent; guardrailBlocked?: true }
  /** A log line of the run that is not an event (checks passing, container up). */
  | { type: "info"; text: string }
  /** The run was saved; `view` is its run.json + log.txt through the orchestrator's replay. */
  | { type: "end"; view: ReplayView }
  /** No usable run: refused, crashed, timed out, sandbox gone. */
  | { type: "failed"; reason: string };

export const encodeSse = (m: LiveWire): string => `event: ${m.type}\ndata: ${JSON.stringify(m)}\n\n`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A wire message out of parsed JSON, or undefined when it is not one. */
export function parseWire(raw: unknown): LiveWire | undefined {
  if (!isObj(raw)) return undefined;
  switch (raw.type) {
    case "timeline": {
      const e = raw.event;
      if (!isObj(e) || typeof e.t !== "number" || !Number.isFinite(e.t) || typeof e.type !== "string" || typeof e.summary !== "string") return undefined;
      return { type: "timeline", event: e as unknown as TimelineEvent, ...(raw.guardrailBlocked === true ? { guardrailBlocked: true as const } : {}) };
    }
    case "info":
      return typeof raw.text === "string" ? { type: "info", text: raw.text } : undefined;
    case "end": {
      const v = raw.view;
      if (!isObj(v) || !Array.isArray(v.events) || typeof v.outcome !== "string") return undefined;
      return { type: "end", view: v as unknown as ReplayView };
    }
    case "failed":
      return typeof raw.reason === "string" ? { type: "failed", reason: raw.reason } : undefined;
    default:
      return undefined;
  }
}

const BUFFER_MAX = 4 * 1024 * 1024;

/** Feeds on text chunks cut anywhere; returns the messages each chunk completes. */
export function createSseDecoder(): { push(chunk: string): LiveWire[] } {
  let buf = "";
  return {
    push(chunk) {
      buf = (buf + chunk).replace(/\r\n/g, "\n");
      const out: LiveWire[] = [];
      let end: number;
      while ((end = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data === "") continue;
        try {
          const m = parseWire(JSON.parse(data));
          if (m) out.push(m);
        } catch {
          // Not JSON: not ours.
        }
      }
      if (buf.length > BUFFER_MAX) buf = "";
      return out;
    },
  };
}
