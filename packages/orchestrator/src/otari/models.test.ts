import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "./env.js";
import { MODELS, OPEN_WEIGHT_MODELS, SELECTORS, isOpenWeight, resolveModel } from "./models.js";

describe("models mirror otari-config/models.json", () => {
  const root = findRepoRoot(import.meta.dirname)!;
  const cfg = JSON.parse(readFileSync(join(root, "otari-config", "models.json"), "utf8")) as {
    roles: Record<string, { id: string; selectors: string[]; openWeights: boolean }>;
  };

  it("ids and primary selectors match", () => {
    for (const r of ["A", "B", "C", "D"] as const) {
      expect(MODELS[r]).toBe(cfg.roles[r]!.id);
      expect(SELECTORS[r]).toBe(cfg.roles[r]!.selectors[0]);
    }
    expect(cfg.roles["A"]!.selectors).toContain(SELECTORS.A_FALLBACK);
  });

  it("rubric resolves to open-weight models only; dev to D only", () => {
    for (const role of ["agent", "judge", "report", "capped", "service"] as const) {
      expect(isOpenWeight(resolveModel("rubric", role))).toBe(true);
      expect(resolveModel("dev", role)).toBe(SELECTORS.D);
    }
    expect(isOpenWeight(SELECTORS.D)).toBe(false);
    expect(OPEN_WEIGHT_MODELS).toHaveLength(3);
  });
});
