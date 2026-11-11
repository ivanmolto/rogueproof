import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = import.meta.dirname;
const read = (rel: string) => JSON.parse(readFileSync(join(DIR, rel), "utf8")) as Record<string, unknown>;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const ROLES = ["agent", "judge", "report", "agent-capped", "agent-service"];

describe("otari-config: no secrets", () => {
  it("contains no key-shaped strings or bearer tokens", () => {
    // Prefixes assembled at runtime so this file passes the gitleaks hook itself.
    const prefixes = [["otk", "v1"].join("_") + "_", ["tk", ""].join("-"), ["gw", ""].join("_"), ["sk", ""].join("-")];
    for (const file of walk(DIR).filter((f) => !f.endsWith(".test.ts"))) {
      const text = readFileSync(file, "utf8");
      for (const p of prefixes) expect(text, `${file} contains ${p}`).not.toMatch(new RegExp(`\\b${p}[A-Za-z0-9_-]{6,}`));
      expect(text).not.toMatch(/bearer\s+[A-Za-z0-9._-]{10,}/i);
    }
  });
});

describe("otari-config/keys.json", () => {
  const keys = read("keys.json") as { keys: { name: string; env: string; shortId: string }[]; baseUrl: string; authHeader: string };
  it("names exactly the five roles, each with an env var and a short id", () => {
    expect(keys.keys.map((k) => k.name).sort()).toEqual([...ROLES].sort());
    for (const k of keys.keys) {
      expect(k.env).toMatch(/^OTARI_API_KEY_[A-Z]+$/);
      expect(k.shortId).toMatch(/^[A-Za-z0-9]{4}$/);
    }
  });
  it("points at the EU gateway with the Otari-Key header", () => {
    expect(keys.baseUrl).toBe(`https://${["eu", "api", "otari", "ai"].join(".")}/api/v1`);
    expect(keys.authHeader).toBe("Otari-Key");
  });
});

describe("otari-config/budgets/keys.json", () => {
  const b = read("budgets/keys.json") as { keys: Record<string, { budget: number; requestLimit?: null }>; total: number };
  it("has a budget per role and the total adds up", () => {
    expect(Object.keys(b.keys).sort()).toEqual([...ROLES].sort());
    const sum = Object.values(b.keys).reduce((s, k) => s + k.budget, 0);
    expect(sum).toBe(b.total);
    expect(b.total).toBeLessThanOrEqual(9);
  });
  it("keeps request_limit reset on agent-capped", () => {
    expect(b.keys["agent-capped"]?.requestLimit).toBeNull();
  });
});

describe("otari-config/models.json", () => {
  type Role = { id: string | null; selectors: string[]; openWeights: boolean; rubric?: boolean };
  const m = read("models.json") as { roles: Record<string, Role>; profiles: Record<string, Record<string, string | null>> };
  const providers = (read("provider-keys.json") as { hostedProviders: { provider: string }[]; ownKeys: { provider: string }[] });
  const known = new Set([...providers.hostedProviders, ...providers.ownKeys].map((p) => p.provider));

  it("A, B and C are open-weight with at least one selector", () => {
    for (const r of ["A", "B", "C"]) {
      const role = m.roles[r]!;
      expect(role.openWeights).toBe(true);
      expect(role.selectors.length).toBeGreaterThan(0);
    }
  });
  it("every selector is provider:id with a provider the workspace enables", () => {
    for (const role of Object.values(m.roles)) {
      for (const sel of role.selectors) {
        const [provider, id] = sel.split(":");
        expect(known.has(provider!)).toBe(true);
        expect(id).toBe(role.id);
      }
    }
  });
  it("D is never a rubric role and the rubric profile uses only A/B/C", () => {
    expect(m.roles["D"]!.openWeights).toBe(false);
    expect(m.roles["D"]!.rubric).toBe(false);
    const rubric = Object.values(m.profiles["rubric"]!);
    expect(rubric.every((r) => r === "A" || r === "B" || r === "C")).toBe(true);
    const dev = Object.values(m.profiles["dev"]!).filter((r) => r !== null);
    expect(dev.every((r) => r === "D")).toBe(true);
  });
  it("A, B and C are three different model families", () => {
    const families = ["A", "B", "C"].map((r) => m.roles[r]!.id!.split("/")[0]);
    expect(new Set(families).size).toBe(3);
  });
});

describe("otari-config/routing", () => {
  const models = read("models.json") as { roles: Record<string, { id: string; openWeights: boolean }> };
  const openWeight = new Set(Object.values(models.roles).filter((r) => r.openWeights).map((r) => r.id));
  const providers = read("provider-keys.json") as { hostedProviders: { provider: string }[]; ownKeys: { provider: string }[] };
  const known = new Set([...providers.hostedProviders, ...providers.ownKeys].map((p) => p.provider));
  const files = readdirSync(join(DIR, "routing")).filter((f) => f.endsWith(".json"));

  it("has the three policies, each a fallback with at least one backup and a known provider per entry", () => {
    expect(files.sort()).toEqual(["agent-primary.json", "dev-primary.json", "report-primary.json"]);
    for (const f of files) {
      const p = read(`routing/${f}`) as { name: string; kind: string; main: { provider: string; selector: string; model: string }; backups: { provider: string; selector: string; model: string }[]; roles: string[] };
      expect(`${p.name}.json`).toBe(f);
      expect(p.name).not.toMatch(/[:/\s]/);
      expect(p.kind).toBe("fallback");
      expect(p.backups.length).toBeGreaterThan(0);
      for (const e of [p.main, ...p.backups]) {
        expect(known.has(e.provider), e.provider).toBe(true);
        expect(e.selector).toBe(`${e.provider}:${e.model}`);
      }
      expect(p.roles.length).toBeGreaterThan(0);
    }
  });

  it("rubric policies serve only open-weight models; dev-primary serves none", () => {
    for (const f of files) {
      const p = read(`routing/${f}`) as { profile: string; main: { model: string }; backups: { model: string }[] };
      const ids = [p.main.model, ...p.backups.map((b) => b.model)];
      if (p.profile === "rubric") for (const id of ids) expect(openWeight.has(id), id).toBe(true);
      else for (const id of ids) expect(openWeight.has(id), id).toBe(false);
    }
  });
});

describe("otari-config/guardrails/injection.json", () => {
  const g = read("guardrails/injection.json") as {
    configured: { name: string; checksCovered: string[]; status: string };
    mandate: { guardrail: string; profile: string; mode: string; ifItCantRun: string; workspaces: string[] };
    observed: { monitor: { status: number; header: { "otari-guardrails": { profile: string; mode: string; score: number }[] }; injection: { header: { "otari-guardrails": { profile: string; mode: string; score: number }[] } } }; blockedWhileInBlockMode: { status: number; body: { detail: { code: string; guardrails: { profile: string }[] } } } };
  };
  it("mandates the configured guardrail in monitor mode on rogueproof only", () => {
    expect(g.mandate.guardrail).toBe(g.configured.name);
    expect(g.configured.checksCovered).toContain("Prompt injection");
    expect(g.configured.status).toBe("Active");
    expect(g.mandate.mode).toBe("monitor");
    expect(g.mandate.ifItCantRun).toBe("refuse");
    expect(g.mandate.workspaces).toEqual(["rogueproof"]);
  });
  it("records the observed block with the mandated profile", () => {
    const b = g.observed.blockedWhileInBlockMode;
    expect(b.status).toBe(403);
    expect(b.body.detail.code).toBe("guardrail_violation");
    expect(b.body.detail.guardrails.map((x) => x.profile)).toEqual([g.mandate.profile]);
  });
  it("records the monitored flag header with the mandated profile and mode", () => {
    expect(g.observed.monitor.status).toBe(200);
    expect(g.observed.monitor.header["otari-guardrails"]).toMatchObject([{ profile: g.mandate.profile, mode: g.mandate.mode }]);
    const inj = g.observed.monitor.injection.header["otari-guardrails"][0]!;
    expect(inj).toMatchObject({ profile: g.mandate.profile, mode: "monitor" });
    expect(inj.score).toBeGreaterThan(g.observed.monitor.header["otari-guardrails"][0]!.score);
  });
});

describe("otari-config/mcp/registry.json", () => {
  const c = read("mcp/registry.json") as {
    name: string; transport: string; urlFrom: { env: string; path: string }; authorizationTokenFrom: { env: string };
    allowedTools: string[]; enabled: boolean; serverId: string | null;
  };
  it("registers the registry by name, with the URL and token taken from .env, never written here", () => {
    expect(c.name).toBe("registry");
    expect(c.transport).toBe("streamable-http");
    expect(c.urlFrom).toEqual({ env: "REGISTRY_PUBLIC_URL", path: "/mcp" });
    expect(c.authorizationTokenFrom).toEqual({ env: "REGISTRY_BEARER" });
    expect(JSON.stringify(c)).not.toMatch(/https?:\/\//);
  });
  it("lets the gateway offer the agent submit_report only: no operator tool, no drop", () => {
    expect(c.allowedTools).toEqual(["submit_report"]);
    expect(c.enabled).toBe(true);
  });
  it("is a different server from the collector, with a UUID once registered", () => {
    const collector = read("mcp/collector.json") as { name: string; serverId: string | null; urlFrom: { env: string }; authorizationTokenFrom: { env: string } };
    expect(c.name).not.toBe(collector.name);
    expect(c.urlFrom.env).not.toBe(collector.urlFrom.env);
    expect(c.authorizationTokenFrom.env).not.toBe(collector.authorizationTokenFrom.env);
    if (c.serverId !== null) {
      expect(c.serverId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(c.serverId).not.toBe(collector.serverId);
    }
  });
});

describe("otari-config/mcp/collector.json", () => {
  const c = read("mcp/collector.json") as {
    name: string; transport: string; urlFrom: { env: string; path: string }; authorizationTokenFrom: { env: string };
    allowedTools: string[]; enabled: boolean; serverId: string | null;
  };
  it("registers the collector by name, with the URL and token taken from .env, never written here", () => {
    expect(c.name).toBe("collector");
    expect(c.transport).toBe("streamable-http");
    expect(c.urlFrom).toEqual({ env: "COLLECTOR_PUBLIC_URL", path: "/mcp" });
    expect(c.authorizationTokenFrom).toEqual({ env: "COLLECTOR_BEARER" });
    expect(JSON.stringify(c)).not.toMatch(/https?:\/\//);
  });
  it("lets the gateway offer the agent drop only, and no tool named like an Otari built-in", () => {
    expect(c.allowedTools).toEqual(["drop"]);
    expect(c.enabled).toBe(true);
  });
  it("records the server id as a UUID once registered", () => {
    if (c.serverId !== null) expect(c.serverId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
