import { describe, expect, it } from "vitest";
import { describeOtari, describeSandbox, otariEnabled, sandboxEnabled } from "./index.js";

describe("test tags", () => {
  it("gates on RUN_OTARI and RUN_SANDBOX", () => {
    expect(otariEnabled({})).toBe(false);
    expect(otariEnabled({ RUN_OTARI: "1" })).toBe(true);
    expect(sandboxEnabled({})).toBe(false);
    expect(sandboxEnabled({ RUN_SANDBOX: "1" })).toBe(true);
  });
});

// Example gated suites: skipped in a plain `pnpm test`.
describeOtari("gateway reachable (placeholder until task 1.3)", () => {
  it.todo("hello via every role");
});

describeSandbox("container offline (placeholder until task 3.4)", () => {
  it.todo("curl https://example.com fails inside the sandbox");
});
