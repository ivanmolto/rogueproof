import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseGuardrailVerdicts } from "./guardrails.js";

describe("parseGuardrailVerdicts", () => {
  it("reads the header as hosted otari.ai sends it", () => {
    const header = '[{"profile":"fake-guard","mode":"monitor","valid":false,"score":1.0,"status":"evaluated"}]';
    expect(parseGuardrailVerdicts(header)).toEqual([{ profile: "fake-guard", mode: "monitor", valid: false, score: 1, status: "evaluated" }]);
  });
  it("is empty for a missing or unreadable header, and drops entries without a verdict", () => {
    expect(parseGuardrailVerdicts(undefined)).toEqual([]);
    expect(parseGuardrailVerdicts("not json")).toEqual([]);
    expect(parseGuardrailVerdicts('{"valid":false}')).toEqual([]);
    expect(parseGuardrailVerdicts('[null, 3, {"valid":"no"}, {"valid":true,"score":"high"}]')).toEqual([
      { profile: "", mode: "", valid: true, score: undefined, status: "" },
    ]);
  });
  it("never throws (fuzz)", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.jsonValue().map((v) => JSON.stringify(v))), (s) => {
        for (const v of parseGuardrailVerdicts(s)) {
          expect(typeof v.valid).toBe("boolean");
          if (v.score !== undefined) expect(Number.isFinite(v.score)).toBe(true);
        }
      }),
    );
  });
});
