import { describe, expect, it } from "vitest";
import { agent, otari, policy, run, sandbox } from "./index.js";

describe("orchestrator skeleton", () => {
  it("exposes the five modules", () => {
    expect([otari.MODULE, agent.MODULE, policy.MODULE, sandbox.MODULE, run.MODULE]).toEqual([
      "otari",
      "agent",
      "policy",
      "sandbox",
      "run",
    ]);
  });
});
