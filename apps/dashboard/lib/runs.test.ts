// Task 5.1: the dashboard's view of each golden run, loaded through the
// orchestrator's replay. Offline: two files per run.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { goldenDir, loadReplay } from "./runs";
import { RUN_KEYS, cardsAt } from "./view";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN = join(ROOT, "runs", "golden");

describe("golden runs as the dashboard sees them", () => {
  it.each(RUN_KEYS)("%s replays with no problem and ends on run.json's cost", async (key) => {
    const v = await loadReplay(key, GOLDEN);
    const record = JSON.parse(readFileSync(join(GOLDEN, key, "run.json"), "utf8")) as { usage: { costUsd: number }; outcome: string; runId: string };
    expect(v.problems).toEqual([]);
    expect(v.events.length).toBeGreaterThan(0);
    expect(v.runId).toBe(record.runId);
    const end = cardsAt(v, v.events.length);
    expect(end.costUsd).toBe(record.usage.costUsd);
    expect(end.status).toBe(record.outcome);
  });

  it("names an end user only where the run's key named one (decision 004)", async () => {
    expect((await loadReplay("safe", GOLDEN)).endUser).toBe("safe-run-10");
    expect((await loadReplay("permissive", GOLDEN)).endUser).toBe("permissive-run-6");
    const budget = await loadReplay("budget", GOLDEN);
    expect(budget.endUser).toBeNull();
    expect(budget.runLabel).toBe("budget-run-1");
  });

  it("shows what each mode is for", async () => {
    const safe = await loadReplay("safe", GOLDEN);
    expect(cardsAt(safe, safe.events.length).denied).toBeGreaterThan(0);
    const budget = await loadReplay("budget", GOLDEN);
    expect(cardsAt(budget, budget.events.length).budgetMessage).toContain("request limit");
    const fallback = await loadReplay("safe-fallback", GOLDEN);
    expect(cardsAt(fallback, fallback.events.length).fallbacks).toBeGreaterThan(0);
    // No golden run recorded a drop: the exfiltration panel stays closed on all of them.
    for (const key of RUN_KEYS) {
      const v = await loadReplay(key, GOLDEN);
      expect(cardsAt(v, v.events.length).exfiltrated).toBe(false);
    }
  });

  it("finds runs/golden from the repo root, from apps/dashboard, or from GOLDEN_RUNS_DIR", () => {
    expect(goldenDir(ROOT, {})).toBe(GOLDEN);
    expect(goldenDir(join(ROOT, "apps", "dashboard"), {})).toBe(GOLDEN);
    expect(goldenDir(ROOT, { GOLDEN_RUNS_DIR: "/somewhere/else" })).toBe("/somewhere/else");
  });
});
