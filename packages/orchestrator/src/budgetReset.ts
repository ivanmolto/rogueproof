// pnpm budget:reset
//
// After `pnpm run:budget`: prints the documented `{"request_limit": null}` PATCH
// (otari-config/budgets/reset.json; org owner's dashboard session or master key,
// never an API key) and verifies, with one GET /key/budget on the capped key,
// that the limit is gone. Makes no model call and costs nothing.
// Exit 0: no request limit. 1: still limited. 2: not readable. Never prints a key.
import { OtariTelemetry, findRepoRoot, loadDotEnv, readOtariEnv } from "./otari/index.js";
import { BUDGET_DOCS, budgetResetReport, readBudgetPatchDoc } from "./run/budgetReset.js";

async function main(): Promise<number> {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) throw new Error("run this from inside the rogueproof repository");
  loadDotEnv();
  const doc = readBudgetPatchDoc(repoRoot, BUDGET_DOCS.reset);
  const report = budgetResetReport(doc, await new OtariTelemetry({ env: readOtariEnv() }).getKeyBudget("capped"));
  for (const line of report.lines) console.log(line);
  return report.code;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
