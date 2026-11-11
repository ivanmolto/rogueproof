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
export const isModeKey = (v: string): v is ModeKey => MODES.some((m) => m.key === v);

/**
 * The modes "Run live" starts. Safe only: a live Permissive run spends one of
 * the bounded rubric tries and rewrites its evidence file, and a Budget-limited
 * run needs the org owner to set request_limit first. Both stay `pnpm run:*`
 * commands, and replays here.
 */
export const LIVE_MODE_KEYS: readonly ModeKey[] = ["safe"];
export const isLiveModeKey = (v: string): v is ModeKey => (LIVE_MODE_KEYS as readonly string[]).includes(v);

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
  status: "ready" | "replaying" | "running" | Outcome;
  /** The gateway's budget refusal, once its event has played. */
  budgetMessage: string | null;
  /** The `post` events played so far: completed drops on the collector. */
  posts: TimelineEvent[];
  /** True when the exfiltration panel may show: a post has played and the collector's own count matches. */
  exfiltrated: boolean;
}

/**
 * The cards after the first `shown` events of the run have played. `open`: a
 * live run that has not ended, so its last event so far is not the run's end.
 */
export function cardsAt(view: ReplayView, shown: number, open = false): Cards {
  const n = Math.max(0, Math.min(Math.trunc(shown) || 0, view.events.length));
  const played = view.events.slice(0, n);
  const done = !open && n === view.events.length && n > 0;
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
    status: open ? "running" : n === 0 ? "ready" : done ? view.outcome : "replaying",
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

/**
 * A live run while it is going: the events received so far and nothing else.
 * Totals, the collector's count and the outcome come from run.json when the
 * run ends, and the server's view then replaces this one.
 */
export function liveView(mode: ModeKey, events: readonly TimelineEvent[], guardrailBlockedRequestIds: readonly string[] = []): ReplayView {
  return {
    run: mode,
    runId: "",
    mode,
    profile: "",
    outcome: "ok",
    endUser: events.find((e) => e.endUser !== undefined)?.endUser ?? null,
    runLabel: "",
    agentModel: "",
    costUsd: null,
    endUserSpendUsd: null,
    collector: null,
    // The orchestrator says which guardrail events are refusals (the live stream's `guardrailBlocked`); nothing here reads the wording.
    guardrailBlockedRequestIds: [...guardrailBlockedRequestIds],
    events: [...events],
    problems: [],
  };
}

/** MODEL_PROFILE a live run will start under; null when it is set to something the run refuses. */
export type LiveProfile = "dev" | "rubric" | null;

/** A profile out of an API answer or a run record; undefined when it is neither a profile nor "not a profile" (null). */
export function parseProfile(v: unknown): LiveProfile | undefined {
  return v === "dev" || v === "rubric" || v === null ? v : undefined;
}

/** What the profile means for a run started now, in the page's words. */
export function profileNote(p: LiveProfile): string {
  if (p === "rubric") return "rubric: open-weight models A/B/C through otari.ai";
  if (p === "dev") return "dev: model D (Claude through otari.ai on your Anthropic provider key); not a rubric run";
  return "not dev or rubric: the run will refuse to start (MODEL_PROFILE in .env)";
}

/** The server stops a live run after four minutes; the page gives up a little later if nothing told it so. */
export const LIVE_CLIENT_TIMEOUT_MS = 4 * 60_000 + 15_000;

/** Outcomes of a saved live run that still call for the golden replay. */
export const isFailedOutcome = (o: Outcome): boolean => o === "error" || o === "tool_error";

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
  running: "Running live…",
  ok: "Mission completed",
  fallback: "Completed on a fallback",
  guardrail_blocked: "Stopped by Otari guardrail",
  budget_exceeded: "Stopped by budget",
  tool_error: "Tool error",
  error: "Error",
  step_cap: "Stopped at the 40-call cap",
};
export const statusText = (s: Cards["status"]): string => STATUS_TEXT[s];

/**
 * The events that carry the 👍/👎 "was this block correct?" controls (task 5.5):
 * a tool-policy denial and the judge model's explanation of it.
 */
export const FEEDBACK_EVENT_TYPES: readonly TimelineEvent["type"][] = ["deny", "judge"];
export const hasFeedbackControls = (type: TimelineEvent["type"]): boolean => FEEDBACK_EVENT_TYPES.includes(type);

/**
 * Why those controls are disabled. Otari's API reference (spec 0.44.0, read
 * 2026-11-11) documents one feedback endpoint, POST /api/v1/feedback, whose body
 * is `message` (+ optional `share_email`) and nothing else: a note to the Otari
 * team, with no rating and no request or trace id, and no way to read it back.
 * On hosted it also answers 401 "Invalid master key" to a workspace API key and
 * to a service key (probed the same day with message-less bodies). A verdict on
 * one event cannot be recorded there, so the dashboard sends nothing.
 */
export const FEEDBACK_DISABLED_REASON =
  "Disabled: Otari's Feedback API (POST /api/v1/feedback) takes a free-text message to the Otari team, with no rating and no request or trace id, and on hosted it refuses a workspace key (401). A verdict cannot be attached to this event. Nothing is sent.";

/**
 * A `deny` is the tool policy's decision, made in the orchestrator before any call
 * leaves the machine: the event carries no Otari request id (only the `judge` call
 * that explains it does), so there would be nothing to rate even with an id field.
 */
export const FEEDBACK_DENY_EXTRA = "A deny is also the tool policy's own decision (app-level, in the orchestrator), so it has no Otari request id.";

/** The tooltip for one event's feedback buttons. */
export const feedbackDisabledReason = (type: TimelineEvent["type"]): string => (type === "deny" ? `${FEEDBACK_DISABLED_REASON} ${FEEDBACK_DENY_EXTRA}` : FEEDBACK_DISABLED_REASON);
