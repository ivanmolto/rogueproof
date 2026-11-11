import { describe, expect, it } from "vitest";
import { endUserLimitHint } from "./cli.js";

describe("endUserLimitHint (task 6.1)", () => {
  it("names the way out when the gateway refused a new end user", () => {
    const hint = endUserLimitHint("info\tagent finished · outcome error · 1 model calls · end_user_limit_reached: This key already has as many end users as it may have", "safe");
    expect(hint).toContain("pnpm run:safe --n");
    expect(hint).toContain("Max end users");
  });

  it("says nothing about any other error", () => {
    expect(endUserLimitHint("agent finished · outcome error · error: Web Retrieval is limited to 10 calls per request", "safe")).toBeUndefined();
    expect(endUserLimitHint("", "permissive")).toBeUndefined();
  });
});
