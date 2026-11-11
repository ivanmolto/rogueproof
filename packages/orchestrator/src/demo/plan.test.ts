import { describe, expect, it } from "vitest";
import { DemoConfigError, planDemo } from "./plan.js";

const FULL = {
  TUNNEL_TOKEN: "t".repeat(40),
  HONEYPOT_PUBLIC_URL: "https://honeypot.example.dev",
  COLLECTOR_PUBLIC_URL: "https://collector.example.dev",
  REGISTRY_PUBLIC_URL: "https://registry.example.dev",
  HONEYPOT_PREFIX: "/p-1234",
  COLLECTOR_BEARER: "fake-collector-bearer",
  REGISTRY_BEARER: "fake-registry-bearer",
};

describe("planDemo", () => {
  it("starts all five services and lists the public URLs when .env is complete", () => {
    const plan = planDemo("/repo", FULL);
    expect(plan.services.map((s) => s.name)).toEqual(["honeypot", "collector", "registry", "tunnel", "dashboard"]);
    expect(plan.services.every((s) => s.skip === undefined)).toBe(true);
    expect(plan.liveReady).toBe(true);
    const urls = Object.fromEntries(plan.urls);
    expect(urls["dashboard"]).toBe("http://localhost:3000");
    expect(urls["honeypot (local)"]).toBe("http://localhost:4444/p-1234/");
    expect(urls["honeypot (public)"]).toBe("https://honeypot.example.dev/p-1234/");
    expect(urls["changelog (public)"]).toBe("https://honeypot.example.dev/p-1234/changelog.html");
    expect(urls["collector MCP (public, bearer required)"]).toBe("https://collector.example.dev/");
    expect(urls["registry MCP (public, bearer required)"]).toBe("https://registry.example.dev/");
  });

  it("on a clean clone (no .env) keeps the honeypot and the dashboard and skips the rest with a reason", () => {
    const plan = planDemo("/repo", {});
    const skipped = plan.services.filter((s) => s.skip !== undefined).map((s) => s.name);
    expect(skipped).toEqual(["collector", "registry", "tunnel"]);
    expect(plan.liveReady).toBe(false);
    expect(plan.urls.map(([label]) => label)).toEqual(["dashboard", "honeypot (local)"]);
  });

  it("never puts a secret in the plan", () => {
    const text = JSON.stringify(planDemo("/repo", FULL));
    for (const secret of [FULL.TUNNEL_TOKEN, FULL.COLLECTOR_BEARER, FULL.REGISTRY_BEARER]) expect(text).not.toContain(secret);
  });

  it("takes the dashboard port from DASHBOARD_PORT and refuses a bad one", () => {
    const plan = planDemo("/repo", { ...FULL, DASHBOARD_PORT: "3200" });
    expect(plan.services.at(-1)).toMatchObject({ name: "dashboard", port: 3200 });
    expect(Object.fromEntries(plan.urls)["dashboard"]).toBe("http://localhost:3200");
    expect(() => planDemo("/repo", { DASHBOARD_PORT: "0" })).toThrow(DemoConfigError);
  });

  it("moves a service to the port its own variable names, and then a live run is not on offer", () => {
    const plan = planDemo("/repo", { ...FULL, HONEYPOT_PORT: "4544" });
    expect(plan.services[0]).toMatchObject({ name: "honeypot", port: 4544 });
    expect(Object.fromEntries(plan.urls)["honeypot (local)"]).toBe("http://localhost:4544/p-1234/");
    expect(plan.liveReady).toBe(false);
    expect(() => planDemo("/repo", { COLLECTOR_PORT: "nope" })).toThrow(DemoConfigError);
  });
});
