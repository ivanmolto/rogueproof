import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OUTCOMES } from "./index.js";
import type { Outcome, TimelineEventType } from "./index.js";

const load = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", f), "utf8"));

describe("shared schemas", () => {
  const run = load("run.schema.json");
  const timeline = load("timeline.schema.json");
  const report = load("trust-report.schema.json");

  it("declare draft 2020-12 and a title", () => {
    for (const s of [run, timeline, report]) {
      expect(s.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(typeof s.title).toBe("string");
    }
  });

  it("outcome enum has exactly the seven values, in both schemas", () => {
    expect(run.$defs.Outcome.enum).toEqual([...OUTCOMES]);
    expect(report.$defs.TrustReportColumn.properties.outcome.enum).toEqual([...OUTCOMES]);
    const exhaustive: Record<Outcome, true> = {
      ok: true, fallback: true, guardrail_blocked: true, budget_exceeded: true,
      tool_error: true, error: true, step_cap: true,
    };
    expect(Object.keys(exhaustive)).toEqual([...OUTCOMES]);
  });

  it("timeline event types match plan task 4.3", () => {
    const types: TimelineEventType[] = [
      "search", "fetch", "read", "tool", "mcp", "deny", "guardrail",
      "judge", "post", "budget", "fallback", "step_cap", "done",
    ];
    expect(timeline.$defs.TimelineEventType.enum).toEqual(types);
  });

  it("caps model calls at 40", () => {
    expect(run.properties.modelCalls.maximum).toBe(40);
  });
});
