import { describe, expect, it } from "vitest";
import { agent, otari, policy, sandbox } from "./index.js";

describe("orchestrator skeleton", () => {
  it("exposes the four modules", () => {
    expect([otari.MODULE, agent.MODULE, policy.MODULE, sandbox.MODULE]).toEqual([
      "otari",
      "agent",
      "policy",
      "sandbox",
    ]);
  });
});
