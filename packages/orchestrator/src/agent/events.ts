// Timeline event wording, shared by the live loop (loop.ts) and replay
// (../run/replay.ts) so a replayed run reads exactly like the run that was
// recorded. Pure functions: no I/O, no gateway.
import type { Outcome, PolicyDecision, TimelineEventType } from "@rogueproof/shared";
import { GUARDRAILS_HEADER, parseGuardrailVerdicts } from "../otari/guardrails.js";
import type { OtariToolCall } from "../otari/toolCalls.js";

export const SUMMARY_MAX = 200;
export const clip = (s: string): string => (s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s);

export interface EventText {
  type: TimelineEventType;
  summary: string;
}

/**
 * Timeline events for one `otari_tool_calls` entry: the only source of
 * `fetch`, `search`, `mcp` and `post`. A `post` is a completed `drop`, never
 * anything else (a `submit_report` is not one). Code execution has no place in
 * the agent's timeline.
 */
export function toolCallEvents(c: OtariToolCall): EventText[] {
  const failed = c.status === "completed" ? "" : ` (${c.status})`;
  switch (c.type) {
    case "web_fetch":
      return [{ type: "fetch", summary: clip(`fetched ${c.url}${failed}`) }];
    case "web_search":
      return [{ type: "search", summary: clip(`searched "${c.query}"${failed}`) }];
    case "mcp": {
      const out: EventText[] = [{ type: "mcp", summary: clip(`${c.server}.${c.name}${failed}`) }];
      if (c.name === "drop" && c.status === "completed") out.push({ type: "post", summary: clip(`payload posted to ${c.server} via drop`) });
      return out;
    }
    case "code_execution":
      return [];
  }
}

/** A local tool call the policy denied. */
export function denyEvent(tool: PolicyDecision["tool"], argsSummary: string, policyName: string, rule: string): EventText {
  return { type: "deny", summary: clip(`${tool} ${argsSummary} — denied by ${policyName} policy (${rule})`) };
}

/** A local tool call the policy allowed and the sandbox ran. */
export function allowedEvent(tool: PolicyDecision["tool"], argsSummary: string): EventText {
  return { type: tool === "read_file" ? "read" : "tool", summary: clip(`${tool} ${argsSummary}`) };
}

export const judgeEvent = (explanation: string): EventText => ({ type: "judge", summary: clip(explanation) });
export const fallbackEvent = (provider: string | undefined): EventText => ({ type: "fallback", summary: `fallback served by ${provider ?? "another provider"}` });
const GUARDRAIL_BLOCK_LEAD = "Otari guardrail blocked the request";
export const guardrailBlockEvent = (detail: string | undefined): EventText => ({
  type: "guardrail",
  summary: clip(`${GUARDRAIL_BLOCK_LEAD}: ${detail ?? "no detail"}`),
});
/**
 * True for the event guardrailBlockEvent makes (a request Otari refused), false for
 * guardrailFlaggedEvent's (flagged and served). Kept beside the wording it reads, so
 * no other module matches on the text. It labels an event already emitted; it decides nothing.
 */
export const isGuardrailBlock = (e: Pick<EventText, "type" | "summary">): boolean => e.type === "guardrail" && e.summary.startsWith(GUARDRAIL_BLOCK_LEAD);
/**
 * A served request that Otari's inference guardrail flagged: the verdict is
 * Otari's own, read from the Otari-Guardrails response header (Monitor mode
 * serves and reports). A refused request has no such event; it gets
 * guardrailBlockEvent instead. Undefined when nothing was flagged.
 */
export function guardrailFlaggedEvent(outcome: Outcome, headers: Readonly<Record<string, string | undefined>> | undefined): EventText | undefined {
  if (outcome === "guardrail_blocked") return undefined;
  const flagged = parseGuardrailVerdicts(headers?.[GUARDRAILS_HEADER]).filter((v) => !v.valid);
  const first = flagged[0];
  if (!first) return undefined;
  const scores = flagged.map((v) => v.score).filter((s): s is number => s !== undefined);
  const score = scores.length > 0 ? `, score ${Math.max(...scores).toFixed(2)}` : "";
  const profiles = [...new Set(flagged.map((v) => v.profile).filter((p) => p !== ""))].join(", ") || "unnamed profile";
  const mode = first.mode === "" ? "" : `, ${first.mode} mode`;
  return { type: "guardrail", summary: clip(`Otari inference guardrail flagged the request (${profiles}${mode}${score}); the request was served`) };
}
export const budgetEvent = (detail: string | undefined): EventText => ({ type: "budget", summary: clip(`budget refused the request: ${detail ?? "no detail"}`) });
export const stepCapEvent = (cap: number): EventText => ({ type: "step_cap", summary: `run stopped at the ${cap}-call cap` });
export const DONE_EVENT: EventText = { type: "done", summary: "mission finished" };
