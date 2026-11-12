// README.md (task 6.3): it must hold on a clean clone. Every relative link resolves to a
// file git tracks or will track (not an ignored one: docs/ is ignored until the submission
// review), every rubric feature has a row with evidence, and the limitations say "app-level".
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const md = readFileSync(join(ROOT, "README.md"), "utf8");
const inGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT }).status === 0;

/** Relative link and image targets, without anchors. */
const targets = [
  ...new Set(
    [...md.matchAll(/\]\(([^)\s]+)\)|\bsrc="([^"]+)"/g)]
      .map((m) => m[1] ?? m[2] ?? "")
      .filter((t) => t !== "" && !/^[a-z]+:/i.test(t) && !t.startsWith("#"))
      .map((t) => t.split("#")[0] ?? ""),
  ),
];

const section = (title: string): string => {
  const start = md.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`README has no section "${title}"`);
  const end = md.indexOf("\n## ", start + 1);
  return md.slice(start, end < 0 ? undefined : end);
};

describe("README.md", () => {
  it("links to things that exist", () => {
    expect(targets.length).toBeGreaterThan(20);
    expect(targets.filter((t) => !existsSync(join(ROOT, t)))).toEqual([]);
  });

  it.skipIf(!inGit)("links to nothing git ignores, so a clean clone has every target", () => {
    const r = spawnSync("git", ["check-ignore", ...targets], { cwd: ROOT, encoding: "utf8" });
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([]);
  });

  it("names the brand, the attribution and the scenario", () => {
    expect(md).toContain("RogueProof — the proving ground for autonomous AI");
    expect(md).toContain("Break your AI agents before the real world does.");
    expect(md).toContain("Built on Otari by Mozilla.ai");
    expect(md).toContain("## Scenario 1: Agent Zero");
    expect(md).not.toMatch(/powered by Mozilla/i);
  });

  it("has one row per rubric feature, each pointing at config, code or a recorded run", () => {
    const rows = section("Otari features, each used in a run")
      .split("\n")
      .filter((l) => /^\| R[1-8]\s*\|/.test(l));
    expect(rows.map((l) => l.slice(2, 4))).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
    for (const row of rows) {
      expect(row, row.slice(0, 6)).toMatch(/\]\((runs\/(golden\/[a-z-]+\/run\.json|trust-report\.json))\)/);
      expect(row, row.slice(0, 6)).toMatch(/\]\((otari-config|packages)\//);
    }
  });

  it("says in the limitations that tool-policy enforcement is app-level, and never that Otari refuses a tool mix", () => {
    const limitations = section("Limitations");
    expect(limitations).toContain("app-level");
    expect(limitations).toContain("not an Otari Agent Guardrail");
    expect(md).not.toMatch(/Otari (refuses|rejects) (the|a) mix/i);
  });

  it("states the pinned SDK version that the orchestrator declares", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", "orchestrator", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    // Either wording: "openai SDK 7.54.0" (status line) or "`openai` 7.54.0" (Versions table).
    const version = (pkg.dependencies["openai"] ?? "").replaceAll(".", "\\.");
    expect(md).toMatch(new RegExp(`openai(\`| SDK) ${version}(?![\\d.])`));
  });
});
