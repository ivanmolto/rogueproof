// Repo-wide guards from CLAUDE.md ("Otari and models", "Repository").
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "dist", ".next", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("no direct provider endpoints", () => {
  it("apps/ and packages/ never name api.openai.com or anthropic.com", () => {
    const pattern = /api\.openai\.com|anthropic\.com/;
    const hits = [...walk(join(ROOT, "apps")), ...walk(join(ROOT, "packages"))]
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});

describe("eslint import boundaries", () => {
  const eslint = new ESLint({ cwd: ROOT });
  const lint = async (code: string, file: string) => {
    const [res] = await eslint.lintText(code, { filePath: join(ROOT, file) });
    return (res?.messages ?? []).map((m) => m.ruleId);
  };
  const importOpenai = 'import OpenAI from "openai";\nexport const c = OpenAI;\n';
  // Host assembled from parts so this file does not itself trip the rule.
  const HOST = ["api", "otari", "ai"].join(".");
  const otariUrl = `export const u = "https://${HOST}/api/v1";\n`;
  const otariTpl = "const h = 'x';\nexport const u = `https://" + HOST + "/${h}`;\n";

  it("allows the OpenAI SDK and the Otari host only in packages/orchestrator/src/otari/", async () => {
    expect(await lint(importOpenai, "packages/orchestrator/src/otari/client.ts")).toEqual([]);
    expect(await lint(otariUrl, "packages/orchestrator/src/otari/client.ts")).toEqual([]);
  });

  it.each([
    "packages/orchestrator/src/agent/loop.ts",
    "packages/orchestrator/src/index.ts",
    "apps/dashboard/app/page.tsx",
    "scenarios/collector/src/index.ts",
    "shared/src/index.ts",
  ])("refuses the OpenAI SDK and the Otari host in %s", async (file) => {
    expect(await lint(importOpenai, file)).toContain("no-restricted-imports");
    expect(await lint('import { x } from "openai/resources";\nexport { x };\n', file)).toContain("no-restricted-imports");
    expect(await lint(otariUrl, file)).toContain("no-restricted-syntax");
    expect(await lint(otariTpl, file)).toContain("no-restricted-syntax");
  });

  it("refuses other provider SDKs everywhere, including the otari module", async () => {
    const code = 'import Anthropic from "@anthropic-ai/sdk";\nexport const a = Anthropic;\n';
    expect(await lint(code, "packages/orchestrator/src/otari/client.ts")).toContain("no-restricted-imports");
    expect(await lint(code, "packages/orchestrator/src/agent/loop.ts")).toContain("no-restricted-imports");
  });

  it("keeps scenarios/ free of Otari and the orchestrator", async () => {
    for (const spec of ["@rogueproof/orchestrator", "../../packages/orchestrator/src/otari/index.js"]) {
      const code = `import * as x from "${spec}";\nexport { x };\n`;
      expect(await lint(code, "scenarios/honeypot/src/index.ts")).toContain("no-restricted-imports");
    }
  });

  it("keeps the dashboard away from the otari module", async () => {
    const code = 'import * as x from "../../packages/orchestrator/src/otari/index.js";\nexport { x };\n';
    expect(await lint(code, "apps/dashboard/app/page.tsx")).toContain("no-restricted-imports");
  });
});
