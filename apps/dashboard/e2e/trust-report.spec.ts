// Task 5.3: the Trust Report page against runs/trust-report.json on disk (what
// `pnpm report` wrote, tracked next to the golden runs), not against the page's
// own loader.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runs", "trust-report.json");

interface Column {
  mode: string;
  control: boolean;
  runId: string;
  outcome: string;
  blockedActions: number;
  guardrailHits: number;
  fallbacks: number;
  drops?: number;
  spendUsd: number;
  endUserSpendUsd?: number;
  models: { role: string; model: string; openWeight: boolean }[];
  judgeFindings?: string[];
}
const report = JSON.parse(readFileSync(FILE, "utf8")) as { columns: Column[]; codeExecutionRequestId?: string };
const usd = (v: number | undefined) => (v === undefined ? "n/a" : `$${v.toFixed(6)}`);

test("every number on the page is the JSON's", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/trust-report");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Trust Report");
  const cols = report.columns;
  const keys = cols.map((c) => (c.control ? "control" : c.mode));
  expect(keys).toEqual(["safe", "permissive", "budget", "control"]);
  await expect(page.getByRole("columnheader")).toContainText(["Safe", "Permissive", "Budget-limited", "Frontier control"]);
  for (const [i, c] of cols.entries()) {
    const k = keys[i]!;
    const cell = (row: string) => page.getByTestId(`cell-${row}-${k}`);
    await expect(cell("run")).toHaveText(c.runId);
    await expect(cell("outcome")).toHaveText(c.outcome);
    await expect(cell("blocked")).toHaveText(String(c.blockedActions));
    await expect(cell("guardrail")).toHaveText(String(c.guardrailHits));
    await expect(cell("fallbacks")).toHaveText(String(c.fallbacks));
    await expect(cell("drops")).toHaveText(String(c.drops ?? 0));
    await expect(cell("spend")).toHaveText(usd(c.spendUsd));
    await expect(cell("end-user-spend")).toHaveText(usd(c.endUserSpendUsd));
    await expect(cell("judge-count")).toHaveText(String(c.judgeFindings?.length ?? 0));
    const models = cell("models").getByTestId("model");
    await expect(models).toHaveCount(c.models.length);
    for (const [j, m] of c.models.entries()) {
      await expect(models.nth(j)).toContainText(m.model);
      await expect(models.nth(j).getByTestId("model-badge")).toHaveText(c.control ? "frontier, non-rubric" : "open-weight");
    }
    const quotes = page.getByTestId(`findings-${k}`).getByTestId("judge-finding");
    await expect(quotes).toHaveCount(c.judgeFindings?.length ?? 0);
    for (const [j, f] of (c.judgeFindings ?? []).entries()) await expect(quotes.nth(j)).toHaveText(`“${f}”`);
  }
  await expect(page.getByTestId("report-call")).toContainText(report.codeExecutionRequestId ?? "?");
  await expect(page.getByTestId("closing-line")).toHaveText("Same agent. Same attack. The only difference was the policy in Otari.");
  expect(errors).toEqual([]);
});

test("the report fits a 390 px phone without sideways page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trust-report");
  await expect(page.getByTestId("closing-line")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
