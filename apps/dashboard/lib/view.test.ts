// Task 5.1: the cards are a pure function of the replayed timeline and run.json.
import type { TimelineEvent } from "@rogueproof/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FEEDBACK_DENY_EXTRA, FEEDBACK_DISABLED_REASON, feedbackDisabledReason, hasFeedbackControls, STEP_MAX_MS, STEP_MIN_MS, cardsAt, collectorNote, isRunKey, runKeyFor, statusText, stepDelay, type ReplayView } from "./view";

const ev = (type: TimelineEvent["type"], over: Partial<TimelineEvent> = {}): TimelineEvent => ({ t: 0, type, summary: type, ...over });
const view = (events: TimelineEvent[], over: Partial<ReplayView> = {}): ReplayView => ({
  run: "safe", runId: "r", mode: "safe", profile: "rubric", outcome: "ok", endUser: "safe-run-1", runLabel: "safe-run-1", agentModel: "fake-model",
  costUsd: 0.5, endUserSpendUsd: 0.4, collector: { drops: 0, crossCheck: "match", fakeSecrets: [] }, guardrailBlockedRequestIds: [], events, problems: [], ...over,
});

describe("cardsAt", () => {
  it("is ready before the first event and replaying until the last", () => {
    const v = view([ev("fetch", { cost: 0.1 }), ev("deny"), ev("done", { cost: 0.2 })]);
    expect(cardsAt(v, 0)).toMatchObject({ status: "ready", costUsd: 0, denied: 0, costIsFinal: false });
    expect(cardsAt(v, 2)).toMatchObject({ status: "replaying", costUsd: 0.1, denied: 1, costIsFinal: false });
  });

  it("shows run.json's total at the end, which includes calls that left no event", () => {
    const v = view([ev("fetch", { cost: 0.1 }), ev("done", { cost: 0.2 })]);
    expect(cardsAt(v, 2)).toMatchObject({ status: "ok", costUsd: 0.5, costIsFinal: true });
    expect(cardsAt(view(v.events, { costUsd: null }), 2).costUsd).toBeCloseTo(0.3);
  });

  it("tells a guardrail refusal from a flagged, served request by Otari's outcome, not by wording", () => {
    const v = view([ev("guardrail", { requestId: "a" }), ev("guardrail", { requestId: "b" }), ev("guardrail")], { guardrailBlockedRequestIds: ["b"] });
    expect(cardsAt(v, 3)).toMatchObject({ guardrailBlocked: 1, guardrailFlagged: 2, denied: 0 });
  });

  it("counts fallbacks and carries the gateway's budget message once its event has played", () => {
    const v = view([ev("fallback"), ev("fallback"), ev("budget", { summary: "budget refused the request: over" })], { outcome: "budget_exceeded" });
    expect(cardsAt(v, 2)).toMatchObject({ fallbacks: 2, budgetMessage: null });
    expect(cardsAt(v, 3)).toMatchObject({ budgetMessage: "budget refused the request: over", status: "budget_exceeded" });
  });

  it("opens the exfiltration panel only for a played post that the collector's own count backs", () => {
    const events = [ev("mcp"), ev("post")];
    const held = { drops: 1, crossCheck: "match" as const, fakeSecrets: ["A"] };
    expect(cardsAt(view(events, { collector: held }), 1).exfiltrated).toBe(false);
    expect(cardsAt(view(events, { collector: held }), 2).exfiltrated).toBe(true);
    expect(cardsAt(view(events, { collector: { ...held, crossCheck: "mismatch" } }), 2).exfiltrated).toBe(false);
    expect(cardsAt(view(events, { collector: { ...held, drops: 0 } }), 2).exfiltrated).toBe(false);
    expect(cardsAt(view(events, { collector: null }), 2).exfiltrated).toBe(false);
    // A submit_report is an mcp event, never a post.
    expect(cardsAt(view([ev("mcp", { summary: "registry.submit_report" })], { collector: held }), 1).exfiltrated).toBe(false);
  });

  it("never throws and never counts past the events, for any position", () => {
    const types = ["search", "fetch", "read", "tool", "mcp", "deny", "guardrail", "judge", "post", "budget", "fallback", "step_cap", "done"] as const;
    const event = fc.record({ t: fc.nat(), type: fc.constantFrom(...types), summary: fc.string(), cost: fc.double({ min: 0, max: 1, noNaN: true }) });
    fc.assert(
      fc.property(fc.array(event, { maxLength: 30 }), fc.oneof(fc.integer(), fc.double()), (events, shown) => {
        const c = cardsAt(view(events), shown);
        expect(c.denied + c.guardrailBlocked + c.guardrailFlagged + c.fallbacks + c.posts.length).toBeLessThanOrEqual(events.length);
        expect(c.costUsd).toBeGreaterThanOrEqual(0);
        expect(statusText(c.status)).not.toBe("");
      }),
    );
  });
});

describe("collectorNote", () => {
  const note = (events: TimelineEvent[], over: Partial<ReplayView>, shown = events.length) => {
    const v = view(events, over);
    return collectorNote(v, cardsAt(v, shown));
  };

  it("says the collector was empty once a replay has ended with no drop", () => {
    expect(note([ev("fetch"), ev("done")], {})).toBe("No exfiltration in this run: the collector held 0 payloads afterwards and Otari reported no drop call.");
    expect(note([ev("done")], { collector: { drops: 0, crossCheck: null, fakeSecrets: [] } })).toBe("No exfiltration in this run: the collector held 0 payloads afterwards.");
  });

  it("is silent while playing, when the panel is open, and when the run has no collector reading", () => {
    expect(note([ev("fetch"), ev("done")], {}, 1)).toBeNull();
    expect(note([ev("mcp"), ev("post")], { collector: { drops: 1, crossCheck: "match", fakeSecrets: [] } })).toBeNull();
    expect(note([ev("done")], { collector: null })).toBeNull();
  });

  it("never calls a run clean when the collector held something", () => {
    expect(note([ev("post")], { collector: { drops: 2, crossCheck: "mismatch", fakeSecrets: [] } })).toContain("held 2 payloads");
    expect(note([ev("done")], { collector: { drops: 1, crossCheck: "match", fakeSecrets: [] } })).toContain("held 1 payload after");
    for (const text of [note([ev("post")], { collector: { drops: 2, crossCheck: "mismatch", fakeSecrets: [] } }), note([ev("done")], { collector: { drops: 1, crossCheck: "match", fakeSecrets: [] } })]) {
      expect(text).not.toContain("No exfiltration");
    }
  });
});

describe("playback", () => {
  it("compresses the recorded gap and clamps it", () => {
    const events = [ev("fetch", { t: 0 }), ev("tool", { t: 10 }), ev("tool", { t: 5000 }), ev("done", { t: 600000 })];
    expect(stepDelay(events, 0)).toBe(STEP_MIN_MS);
    expect(stepDelay(events, 1)).toBe(STEP_MIN_MS);
    expect(stepDelay(events, 2)).toBeGreaterThan(STEP_MIN_MS);
    expect(stepDelay(events, 2)).toBeLessThan(STEP_MAX_MS);
    expect(stepDelay(events, 3)).toBe(STEP_MAX_MS);
    expect(stepDelay(events, 99)).toBe(STEP_MIN_MS);
  });

  it("maps a mode to its golden run and accepts only known run names", () => {
    expect(runKeyFor("safe", false)).toBe("safe");
    expect(runKeyFor("safe", true)).toBe("safe-fallback");
    expect(runKeyFor("budget", true)).toBe("budget");
    expect(isRunKey("permissive")).toBe(true);
    expect(isRunKey("../../.env")).toBe(false);
  });
});

// Task 5.5: the feedback controls exist on denials and judge explanations only. Their tooltip is checked where it is rendered (e2e/replay.spec.ts).
describe("feedback controls", () => {
  it("sit on deny and judge events and on no other type", () => {
    const types: TimelineEvent["type"][] = ["search", "fetch", "mcp", "post", "guardrail", "budget", "fallback", "read", "tool", "deny", "judge", "step_cap", "done"];
    expect(types.filter(hasFeedbackControls)).toEqual(["deny", "judge"]);
  });

  it("a deny's tooltip adds that it has no Otari request id; a judge's does not", () => {
    expect(feedbackDisabledReason("judge")).toBe(FEEDBACK_DISABLED_REASON);
    expect(feedbackDisabledReason("deny")).toBe(`${FEEDBACK_DISABLED_REASON} ${FEEDBACK_DENY_EXTRA}`);
    expect(FEEDBACK_DENY_EXTRA).toMatch(/no Otari request id/);
  });
});
