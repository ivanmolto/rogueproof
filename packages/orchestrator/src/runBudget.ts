// pnpm run:budget [--golden] [--n <number>] [--agent-model A|B|C]
//
// Agent Zero, Budget-limited mode (task 4.2, rubric feature R5): the Safe
// scenario (policies/safe/, judge gate, mandated inference guardrail) with the
// agent on the `agent-capped` key, whose budget carries a `request_limit`. The
// gateway serves that many requests and refuses the next one; the refusal is
// the run's `budget_exceeded` outcome and is saved in run.json as `budgetStop`.
// No credit is burned to get there.
//
// Before: the org owner sets the limit (otari-config/budgets/request-limit.json;
// an API key cannot). The run refuses to start unless GET /key/budget on the
// capped key shows a request limit with requests left.
// After: `pnpm budget:reset` (otari-config/budgets/reset.json).
//
// `agent-capped` is a plain key and may not name an end user, so
// `budget-run-<n>` is the run's label in run.json; no `user` field is sent.
// Judge calls are on the `judge` key and do not count against the limit.
// Needs `pnpm honeypot`, `pnpm collector`, `pnpm registry` and `pnpm tunnel`
// running, and Docker. Output: runs/<timestamp>-budget/. Exit 1 when anything
// but the budget ended the run. The command itself is run/cli.ts.
import { mainCli } from "./run/cli.js";

mainCli("budget");
