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
