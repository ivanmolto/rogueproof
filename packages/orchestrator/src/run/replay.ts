// pnpm replay <runDir>: rebuilds a run's timeline from the two files the run
// left behind, with no model call and no network.
//
//   run.json  is the evidence. `fetch`, `search`, `mcp` and `post` are rebuilt
//             from the saved `otari_tool_calls` arrays and carry that call's
//             Otari request id; `read`, `tool`, `deny` from `policyDecisions`;
//             `judge` from `judgeFindings`; `fallback`, `budget` and
//             `guardrail` from the calls' outcomes and Otari-* headers.
//   log.txt   is the clock. Its `event` lines give each event's `t` and the
//             order in which gateway and local events interleaved, which
//             run.json does not record.
//
// A log line that run.json does not back is left out and reported; so is a
// run.json record with no log line. A golden run replays with no such problem.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { GatewayCall, RunRecord, Timeline, TimelineEvent, TimelineEventType } from "@rogueproof/shared";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  DONE_EVENT, allowedEvent, budgetEvent, denyEvent, fallbackEvent, guardrailBlockEvent, guardrailFlaggedEvent, judgeEvent, toolCallEvents, type EventText,
} from "../agent/events.js";
import { parseOtariToolCalls } from "../otari/toolCalls.js";
import { validateRunRecord } from "./record.js";

const require = createRequire(import.meta.url);
const schema = JSON.parse(readFileSync(require.resolve("@rogueproof/shared/timeline.schema.json"), "utf8")) as object;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

/** Schema violations as `path message` lines; empty when `value` is a valid Timeline. */
export function validateTimeline(value: unknown): string[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}

const EVENT_TYPES: ReadonlySet<string> = new Set<TimelineEventType>([
  "search", "fetch", "read", "tool", "mcp", "deny", "guardrail", "judge", "post", "budget", "fallback", "step_cap", "done",
]);
const OPTIONAL_STRINGS = ["endUser", "traceId", "requestId"] as const;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One timeline event out of parsed JSON, or undefined when it is not one. External input: never throws. */
export function parseTimelineEvent(raw: unknown): TimelineEvent | undefined {
  if (!isObj(raw)) return undefined;
  const { t, type, summary, cost } = raw;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return undefined;
  if (typeof type !== "string" || !EVENT_TYPES.has(type) || typeof summary !== "string") return undefined;
  const e: TimelineEvent = { t, type: type as TimelineEventType, summary };
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) e.cost = cost;
  for (const k of OPTIONAL_STRINGS) {
    const v = raw[k];
    if (typeof v === "string") e[k] = v;
  }
  return e;
}

export interface LoggedEvent {
  /** 1-based line number in log.txt. */
  line: number;
  event: TimelineEvent;
}

/**
 * The `event` lines of a log.txt (`<iso time>\tevent\t<json>`), in file order.
 * Every other line, and any event line that does not parse, is skipped.
 * External input: never throws.
 */
export function parseLogEvents(text: string): LoggedEvent[] {
  const out: LoggedEvent[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i]!.split("\t");
    if (parts.length < 3 || parts[1] !== "event") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(parts.slice(2).join("\t"));
    } catch {
      continue;
    }
    const event = parseTimelineEvent(raw);
    if (event) out.push({ line: i + 1, event });
  }
  return out;
}

export interface ReplayResult {
  timeline: Timeline;
  /** Where log.txt and run.json disagree. Empty for a run that replays cleanly. */
  problems: string[];
}

const LOCAL: ReadonlySet<TimelineEventType> = new Set<TimelineEventType>(["read", "tool", "deny"]);

/**
 * A golden copy has hosts replaced after the live summary was clipped, so a
 * clipped summary rebuilt from the redacted run.json can be cut at another
 * character than the logged one. Same text up to the cut is the same summary.
 */
function sameSummary(logged: string, rebuilt: string): boolean {
  if (logged === rebuilt) return true;
  const cut = (x: string): string | undefined => (x.endsWith("…") ? x.slice(0, -1) : undefined);
  const a = cut(logged);
  const b = cut(rebuilt);
  return (a !== undefined && rebuilt.startsWith(a)) || (b !== undefined && logged.startsWith(b));
}

interface Built {
  event: TimelineEvent;
  /** Index into run.json's `calls` of the gateway call this event comes from. */
  call?: number;
}

/** Rebuilds the timeline of one run. Pure: no I/O. Never throws on a schema-valid record and any log text. */
export function replayRun(record: RunRecord, logText: string): ReplayResult {
  const problems: string[] = [];
  const calls = record.calls ?? [];
  // The capped key is a plain key and names no end user (decision 004): the run's label is not an end user.
  const endUser = calls.some((c) => c.role === "agent-capped") ? undefined : record.endUser;
  const policyName = record.mode === "permissive" || record.mode === "control" ? "permissive" : "safe";

  // What run.json backs, per source.
  const byRequest = new Map<string, number>();
  const gateway: EventText[][] = calls.map((c, i) => {
    if (c.requestId !== undefined && !byRequest.has(c.requestId)) byRequest.set(c.requestId, i);
    const q = parseOtariToolCalls(c.otariToolCalls).flatMap(toolCallEvents);
    if (c.outcome === "fallback" || c.otariHeaders?.["otari-fallback"] === "true") q.push(fallbackEvent(c.otariHeaders?.["otari-provider"]));
    if (c.outcome === "guardrail_blocked") q.push(guardrailBlockEvent(undefined));
    if (c.outcome === "budget_exceeded") q.push(budgetEvent(record.budgetStop?.message));
    if (c.requestId === undefined && q.length > 0) {
      problems.push(`run.json call ${i + 1} has no request id: its ${q.length} gateway event(s) are left out`);
      return [];
    }
    return q;
  });
  // Served calls Otari's guardrail flagged. Runs recorded since the loop emits these have a log line for each; older ones do not.
  const flagged: (EventText | undefined)[] = calls.map((c) => guardrailFlaggedEvent(c.outcome, c.otariHeaders));
  const local: EventText[] = (record.policyDecisions ?? []).map((d) =>
    d.decision === "deny" ? denyEvent(d.tool, d.argsSummary ?? "", policyName, d.rule ?? "") : allowedEvent(d.tool, d.argsSummary ?? ""),
  );
  const findings = [...(record.judgeFindings ?? [])];
  let lastAgentCall: number | undefined;
  calls.forEach((c, i) => {
    if (c.turn !== "judge") lastAgentCall = i;
  });

  const out: Built[] = [];
  const push = (logged: LoggedEvent, text: EventText, call: number | undefined, requestId: string | undefined): void => {
    const event: TimelineEvent = { t: logged.event.t, type: text.type, summary: text.summary };
    if (endUser !== undefined) event.endUser = endUser;
    if (requestId !== undefined) event.requestId = requestId;
    const was = logged.event;
    if (!sameSummary(was.summary, event.summary) || was.requestId !== event.requestId || was.endUser !== event.endUser) {
      problems.push(`log.txt line ${logged.line}: the ${event.type} event rebuilt from run.json differs from the logged one`);
    }
    out.push(call === undefined ? { event } : { event, call });
  };

  for (const logged of parseLogEvents(logText)) {
    const e = logged.event;
    switch (e.type) {
      case "fetch":
      case "search":
      case "mcp":
      case "post":
      case "fallback":
      case "budget":
      case "guardrail": {
        const has = (i: number): boolean => gateway[i]!.some((x) => x.type === e.type);
        const named = e.requestId === undefined ? undefined : byRequest.get(e.requestId);
        // A flagged, served call: the logged line names it by request id (or, for a call the gateway gave none, by order).
        const served = e.type !== "guardrail" ? -1 : named ?? (e.requestId === undefined ? flagged.findIndex((f, i) => f !== undefined && calls[i]!.requestId === undefined) : -1);
        const verdict = flagged[served];
        if (verdict !== undefined) {
          flagged[served] = undefined;
          push(logged, verdict, served, calls[served]!.requestId);
          break;
        }
        const ci = named !== undefined && has(named) ? named : gateway.findIndex((_, i) => has(i));
        if (ci < 0) {
          problems.push(`log.txt line ${logged.line}: ${e.type} event has no entry left in run.json; left out`);
          break;
        }
        const q = gateway[ci]!;
        const [text] = q.splice(q.findIndex((x) => x.type === e.type), 1);
        // run.json keeps a block's outcome, not the gateway's wording: that part is the log's.
        push(logged, e.type === "guardrail" ? { type: "guardrail", summary: e.summary } : text!, ci, calls[ci]!.requestId);
        break;
      }
      case "read":
      case "tool":
      case "deny": {
        const text = local.shift();
        if (!text) {
          problems.push(`log.txt line ${logged.line}: ${e.type} event has no policy decision left in run.json; left out`);
          break;
        }
        push(logged, text, undefined, undefined);
        break;
      }
      case "judge": {
        const f = findings.shift();
        if (!f) {
          problems.push(`log.txt line ${logged.line}: judge event has no judge finding left in run.json; left out`);
          break;
        }
        push(logged, judgeEvent(f.explanation), f.requestId === undefined ? undefined : byRequest.get(f.requestId), f.requestId);
        break;
      }
      case "done":
        if (record.outcome !== "ok") {
          problems.push(`log.txt line ${logged.line}: done event, but run.json's outcome is ${record.outcome}; left out`);
          break;
        }
        push(logged, DONE_EVENT, lastAgentCall, lastAgentCall === undefined ? undefined : calls[lastAgentCall]!.requestId);
        break;
      case "step_cap":
        if (record.outcome !== "step_cap") {
          problems.push(`log.txt line ${logged.line}: step_cap event, but run.json's outcome is ${record.outcome}; left out`);
          break;
        }
        push(logged, { type: "step_cap", summary: e.summary }, undefined, undefined);
        break;
      default: {
        const unhandled: never = e.type;
        throw new Error(`unhandled event type ${String(unhandled)}`);
      }
    }
  }

  const leftover = new Map<string, number>();
  const count = (type: string, n = 1): void => void leftover.set(type, (leftover.get(type) ?? 0) + n);
  for (const q of gateway) for (const x of q) count(x.type);
  for (const x of local) count(x.type);
  if (findings.length > 0) count("judge", findings.length);
  for (const [type, n] of leftover) problems.push(`run.json backs ${n} ${type} event(s) that log.txt has no line for; left out`);

  const events = withFlaggedCalls(out, calls, flagged, endUser);

  // Each call's cost and trace id go on the first event that came from it.
  const seen = new Set<number>();
  for (const b of events) {
    if (b.call === undefined || seen.has(b.call)) continue;
    seen.add(b.call);
    const c = calls[b.call]!;
    if (c.costUsd !== undefined) b.event.cost = c.costUsd;
    if (c.traceId !== undefined) b.event.traceId = c.traceId;
  }
  return { timeline: { schemaVersion: 1, runId: record.runId, events: events.map((b) => b.event) }, problems };
}

/**
 * Adds a `guardrail` event for every flagged served call (`flagged`, from the
 * Otari-Guardrails headers saved in run.json) that log.txt has no line for:
 * runs recorded before the live loop emitted them. The position is: just before the call's first logged
 * event when one names it (research, judge and final calls). An act call whose
 * only trace is local tool events has no request id in the log; those are
 * placed before a local event between the neighbouring named calls, splitting
 * at the longest pauses (a model call takes seconds, a tool batch milliseconds).
 * The verdict and request id are exact; that position is an estimate.
 */
function withFlaggedCalls(out: readonly Built[], calls: readonly GatewayCall[], flagged: readonly (EventText | undefined)[], endUser: string | undefined): Built[] {
  const anchor = new Map<number, number>();
  out.forEach((b, i) => {
    if (b.call !== undefined && !anchor.has(b.call)) anchor.set(b.call, i);
  });
  /** Events to insert before index i of `out` (out.length: at the end). */
  const before = new Map<number, Built[]>();
  const add = (at: number, call: number): void => {
    const text = flagged[call];
    if (!text) return;
    const t = out[at]?.event.t ?? out[out.length - 1]?.event.t ?? 0;
    const event: TimelineEvent = { t, ...text };
    if (endUser !== undefined) event.endUser = endUser;
    const requestId = calls[call]!.requestId;
    if (requestId !== undefined) event.requestId = requestId;
    before.set(at, [...(before.get(at) ?? []), { event, call }]);
  };
  const place = (pending: readonly number[], lo: number, hi: number): void => {
    if (pending.length === 0) return;
    const cands: number[] = [];
    for (let i = lo + 1; i < hi; i++) if (LOCAL.has(out[i]!.event.type)) cands.push(i);
    if (cands.length === 0) {
      for (const c of pending) add(Math.max(hi, 0), c);
      return;
    }
    const cuts = cands
      .slice(1)
      .map((at, k) => ({ at, gap: out[at]!.event.t - out[cands[k]!]!.event.t }))
      .sort((a, b) => b.gap - a.gap || a.at - b.at)
      .slice(0, pending.length - 1)
      .map((x) => x.at)
      .sort((a, b) => a - b);
    const starts = [cands[0]!, ...cuts];
    pending.forEach((c, k) => add(starts[Math.min(k, starts.length - 1)]!, c));
  };

  let last = -1;
  let pending: number[] = [];
  for (let i = 0; i < calls.length; i++) {
    const at = anchor.get(i);
    if (at === undefined) {
      pending.push(i);
      continue;
    }
    place(pending, last, at > last ? at : out.length);
    pending = [];
    add(at, i);
    last = Math.max(last, at);
  }
  place(pending, last, out.length);

  const merged: Built[] = [];
  for (let i = 0; i <= out.length; i++) {
    merged.push(...(before.get(i) ?? []));
    if (i < out.length) merged.push({ ...out[i]!, event: { ...out[i]!.event } });
  }
  return merged;
}

export class ReplayError extends Error {
  override readonly name = "ReplayError";
}

/** Replays the run saved in `dir` (run.json + log.txt). Reads those two files and nothing else. */
export function replayDir(dir: string): ReplayResult & { record: RunRecord } {
  let raw: unknown;
  let log: string;
  try {
    raw = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    log = readFileSync(join(dir, "log.txt"), "utf8");
  } catch (e) {
    throw new ReplayError(`${dir}: cannot read run.json and log.txt (${e instanceof Error ? e.message : String(e)})`);
  }
  const violations = validateRunRecord(raw);
  if (violations.length > 0) throw new ReplayError(`${dir}: run.json does not match shared/run.schema.json:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
  const record = raw as RunRecord;
  const result = replayRun(record, log);
  const bad = validateTimeline(result.timeline);
  if (bad.length > 0) throw new ReplayError(`${dir}: the rebuilt timeline does not match shared/timeline.schema.json:\n${bad.map((v) => `  - ${v}`).join("\n")}`);
  return { ...result, record };
}

/** Lines `pnpm replay` prints for one run. */
export function renderReplay(dir: string, r: ReplayResult & { record: RunRecord }): string[] {
  const counts = new Map<string, number>();
  for (const e of r.timeline.events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const lines = [
    `replay ${dir} · ${r.record.mode} · outcome ${r.record.outcome} · ${r.timeline.events.length} events · ${[...counts].map(([t, n]) => `${t} ${n}`).join(", ") || "none"}`,
    ...r.timeline.events.map((e) => `  ${String(e.t).padStart(7)} ms  ${e.type.padEnd(9)} ${e.summary}${e.requestId === undefined ? "" : `  [${e.requestId}]`}`),
    ...r.problems.map((p) => `  PROBLEM · ${p}`),
  ];
  lines.push(r.problems.length === 0 ? "  replay ok: every event is backed by run.json, no model call, no network" : `  replay FAILED: ${r.problems.length} problem(s)`);
  return lines;
}
