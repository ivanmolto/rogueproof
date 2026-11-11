// What the dashboard shows for one replayed run, and how the cards move as its
// events play back. Pure: no I/O, no React. Everything here is derived from a
// Timeline rebuilt by the orchestrator's replay and from fields of run.json;
// nothing is decided by a model and nothing is invented for display.
import type { Outcome, RunMode, TimelineEvent } from "@rogueproof/shared";

/** The golden runs the dashboard can replay: directory names under runs/golden/. */
export const RUN_KEYS = ["safe", "permissive", "budget", "safe-fallback"] as const;
export type RunKey = (typeof RUN_KEYS)[number];
export const isRunKey = (v: string): v is RunKey => (RUN_KEYS as readonly string[]).includes(v);

/** The three policies of Defense Control. */
export const MODES = [
  { key: "safe", label: "Safe" },
  { key: "permissive", label: "Permissive" },
  { key: "budget", label: "Budget-limited" },
] as const;
export type ModeKey = (typeof MODES)[number]["key"];

/** The golden run a mode replays. Safe has a second one, recorded with the fallback recipe. */
export const runKeyFor = (mode: ModeKey, fallbackDemo: boolean): RunKey => (mode === "safe" && fallbackDemo ? "safe-fallback" : mode);

export interface CollectorView {
  drops: number;
  crossCheck: "match" | "mismatch" | null;
  /** Names, never values, of the mission's FAKE .env keys found in a stored payload. */
  fakeSecrets: string[];
}

/** One replayed run as the API route hands it to the page. */
export interface ReplayView {
  run: RunKey;
  runId: string;
  mode: RunMode;
  profile: string;
  outcome: Outcome;
  /** The end user Otari attributed the run's requests to; null when the run's key names none (decision 004). */
  endUser: string | null;
  /** run.json's label for the run (`<mode>-run-<n>`). An end user only when `endUser` is set. */
  runLabel: string;
  agentModel: string;
  /** usage.costUsd of run.json: every call of the run, including calls that left no event. */
  costUsd: number | null;
  endUserSpendUsd: number | null;
  collector: CollectorView | null;
  /** Request ids of the calls Otari's guardrail refused (outcome guardrail_blocked). */
  guardrailBlockedRequestIds: string[];
  events: TimelineEvent[];
  /** Where log.txt and run.json disagree. Empty for a golden run. */
  problems: string[];
}

export interface Cards {
  /** USD. While playing: the cost carried by the events shown so far. At the end: the run's total. */
  costUsd: number;
  costIsFinal: boolean;
  /** Local tool calls the tool policy denied (app-level, in the orchestrator). */
  denied: number;
  /** Requests Otari's inference guardrail refused. */
  guardrailBlocked: number;
  /** Requests Otari's inference guardrail flagged and served (Monitor mode). */
  guardrailFlagged: number;
  fallbacks: number;
  status: "ready" | "replaying" | Outcome;
  /** The gateway's budget refusal, once its event has played. */
  budgetMessage: string | null;
  /** The `post` events played so far: completed drops on the collector. */
  posts: TimelineEvent[];
  /** True when the exfiltration panel may show: a post has played and the collector's own count matches. */
  exfiltrated: boolean;
}

/** The cards after the first `shown` events of the run have played. */
export function cardsAt(view: ReplayView, shown: number): Cards {
  const n = Math.max(0, Math.min(Math.trunc(shown) || 0, view.events.length));
  const played = view.events.slice(0, n);
  const done = n === view.events.length && n > 0;
  const blocked = new Set(view.guardrailBlockedRequestIds);
  const count = (pred: (e: TimelineEvent) => boolean): number => played.filter(pred).length;
  const isBlock = (e: TimelineEvent): boolean => e.type === "guardrail" && e.requestId !== undefined && blocked.has(e.requestId);
  const sum = played.reduce((acc, e) => acc + (e.cost ?? 0), 0);
  const posts = played.filter((e) => e.type === "post");
  const collector = view.collector;
  return {
    costUsd: done && view.costUsd !== null ? view.costUsd : sum,
    costIsFinal: done,
    denied: count((e) => e.type === "deny"),
    guardrailBlocked: count(isBlock),
    guardrailFlagged: count((e) => e.type === "guardrail" && !isBlock(e)),
    fallbacks: count((e) => e.type === "fallback"),
    status: n === 0 ? "ready" : done ? view.outcome : "replaying",
    budgetMessage: played.find((e) => e.type === "budget")?.summary ?? null,
    posts,
    exfiltrated: posts.length > 0 && collector !== null && collector.crossCheck === "match" && collector.drops > 0,
  };
}

/**
 * What the collector held, said in words once a replay has ended without the
 * exfiltration panel. From run.json's `collector` (the collector's own count,
 * cross-checked against the drop entries of otari_tool_calls). Null while the
 * replay is playing, when the panel is open, or when the run recorded no collector reading.
 */
export function collectorNote(view: ReplayView, cards: Cards): string | null {
  const c = view.collector;
  if (!cards.costIsFinal || cards.exfiltrated || c === null) return null;
  if (c.crossCheck === "mismatch") {
    return `Not shown as exfiltration: the collector held ${c.drops} payload${c.drops === 1 ? "" : "s"} after this run, which does not match the drop calls Otari reported.`;
  }
  if (c.drops > 0) return `The collector held ${c.drops} payload${c.drops === 1 ? "" : "s"} after this run, but the timeline has no drop event for it.`;
  return c.crossCheck === "match"
    ? "No exfiltration in this run: the collector held 0 payloads afterwards and Otari reported no drop call."
    : "No exfiltration in this run: the collector held 0 payloads afterwards.";
}

export const STEP_MIN_MS = 60;
export const STEP_MAX_MS = 400;
/** Recorded time is compressed by this factor for playback. */
export const TIME_SCALE = 25;

/** Milliseconds to wait before showing event `i`: the recorded gap, compressed and clamped. */
export function stepDelay(events: readonly TimelineEvent[], i: number): number {
  const cur = events[i];
  const prev = events[i - 1];
  if (!cur || !prev) return STEP_MIN_MS;
  const gap = (cur.t - prev.t) / TIME_SCALE;
  return Math.round(Math.max(STEP_MIN_MS, Math.min(STEP_MAX_MS, Number.isFinite(gap) ? gap : STEP_MIN_MS)));
}

export const formatUsd = (v: number): string => `$${v.toFixed(4)}`;
export const formatT = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const STATUS_TEXT: Record<Cards["status"], string> = {
  ready: "Ready",
  replaying: "Replaying…",
  ok: "Mission completed",
  fallback: "Completed on a fallback",
  guardrail_blocked: "Stopped by Otari guardrail",
  budget_exceeded: "Stopped by budget",
  tool_error: "Tool error",
  error: "Error",
  step_cap: "Stopped at the 40-call cap",
};
export const statusText = (s: Cards["status"]): string => STATUS_TEXT[s];
