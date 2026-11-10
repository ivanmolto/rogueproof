import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseOtariToolCalls } from "./toolCalls.js";

describe("parseOtariToolCalls", () => {
  it("returns an empty array for anything that is not an array", () => {
    for (const v of [undefined, null, 0, "x", {}, { type: "mcp" }]) expect(parseOtariToolCalls(v)).toEqual([]);
  });

  it("drops entries with unknown types and keeps the rest in order", () => {
    const out = parseOtariToolCalls([{ type: "nope" }, { type: "mcp", id: "a", status: "completed", server: "s", name: "n", output: "o" }, 7]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "mcp", id: "a", server: "s" });
  });

  it("never throws and always returns well-typed entries (fuzz)", () => {
    const entry = fc.record(
      {
        type: fc.oneof(fc.constantFrom("web_search", "web_fetch", "code_execution", "mcp"), fc.string()),
        id: fc.anything(),
        status: fc.anything(),
        query: fc.anything(),
        url: fc.anything(),
        sources: fc.anything(),
        code: fc.anything(),
        stdout: fc.anything(),
        stderr: fc.anything(),
        exit_code: fc.anything(),
        file_ids: fc.anything(),
        server: fc.anything(),
        name: fc.anything(),
        output: fc.anything(),
        error: fc.anything(),
        truncated: fc.anything(),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.array(fc.oneof(entry, fc.anything()))), (raw) => {
        const out = parseOtariToolCalls(raw);
        expect(Array.isArray(out)).toBe(true);
        for (const c of out) {
          expect(["web_search", "web_fetch", "code_execution", "mcp"]).toContain(c.type);
          expect(["in_progress", "completed", "failed"]).toContain(c.status);
          expect(typeof c.id).toBe("string");
          if (c.type === "code_execution") expect(c.exit_code === null || typeof c.exit_code === "number").toBe(true);
          if (c.type === "web_search" || c.type === "web_fetch") for (const s of c.sources) expect(typeof s.url).toBe("string");
        }
      }),
      { numRuns: 300 },
    );
  });
});
