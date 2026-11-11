import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "./env.js";
import { MODELS, OPEN_WEIGHT_MODELS, POLICIES, SELECTORS, isOpenWeight, modelsServedBy, resolveModel } from "./models.js";

describe("models mirror otari-config/models.json", () => {
  const root = findRepoRoot(import.meta.dirname)!;
  const cfg = JSON.parse(readFileSync(join(root, "otari-config", "models.json"), "utf8")) as {
    roles: Record<string, { id: string; selectors: string[]; openWeights: boolean }>;
    profiles: Record<string, Record<string, string | null>>;
  };

  it("ids and primary selectors match", () => {
    for (const r of ["A", "B", "C", "D"] as const) {
      expect(MODELS[r]).toBe(cfg.roles[r]!.id);
      expect(SELECTORS[r]).toBe(cfg.roles[r]!.selectors[0]);
    }
    expect(cfg.roles["A"]!.selectors).toContain(SELECTORS.A_FALLBACK);
  });

  it("rubric resolves to policies that serve open-weight models only; dev to dev-primary", () => {
    for (const role of ["agent", "judge", "report", "capped", "service"] as const) {
      expect(isOpenWeight(resolveModel("rubric", role))).toBe(true);
      expect(resolveModel("dev", role)).toBe("dev-primary");
    }
    // Decision 002: the rubric judge is model C sent directly; the report stays on report-primary (B first).
    expect(resolveModel("rubric", "judge")).toBe(SELECTORS.C);
    expect(resolveModel("rubric", "report")).toBe("report-primary");
    expect(modelsServedBy(resolveModel("rubric", "report"))[0]).toBe(MODELS.B);
    const letter = (role: "agent" | "judge" | "report"): string | undefined =>
      (["A", "B", "C"] as const).find((l) => MODELS[l] === modelsServedBy(resolveModel("rubric", role))[0]);
    for (const role of ["agent", "judge", "report"] as const) expect(letter(role)).toBe(cfg.profiles["rubric"]![role]);
    expect(isOpenWeight("dev-primary")).toBe(false);
    expect(isOpenWeight(SELECTORS.D)).toBe(false);
    expect(isOpenWeight(SELECTORS.A)).toBe(true);
    expect(OPEN_WEIGHT_MODELS).toHaveLength(3);
  });

  it("policies mirror otari-config/routing/*.json", () => {
    for (const name of Object.keys(POLICIES) as (keyof typeof POLICIES)[]) {
      const file = JSON.parse(readFileSync(join(root, "otari-config", "routing", `${name}.json`), "utf8")) as {
        name: string; kind: string; profile: string; main: { model: string }; backups: { model: string }[];
      };
      expect(file.name).toBe(name);
      expect(file.kind).toBe("fallback");
      expect(file.profile).toBe(POLICIES[name].profile);
      expect([file.main.model, ...file.backups.map((b) => b.model)]).toEqual([...modelsServedBy(name)]);
    }
  });
});
