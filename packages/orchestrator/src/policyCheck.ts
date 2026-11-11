// pnpm policy:check
// Runs the 10-call fixture (policies/fixtures/ten-calls.json) against
// policies/safe and policies/permissive. Exit 0 when every call is classified
// as the fixture expects, 1 otherwise. Offline; no model, no gateway.
import { join } from "node:path";
import { findRepoRoot } from "./otari/env.js";
import { checkPolicies } from "./policy/index.js";

function main(): number {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) throw new Error("run this from inside the rogueproof repository");
  const r = checkPolicies(join(repoRoot, "policies"));
  for (const row of r.rows) {
    const line = `${row.pass ? "ok  " : "FAIL"}  ${row.policy.padEnd(10)}  ${row.label.padEnd(9)}  ${row.id.padEnd(18)}  ${row.actual}`;
    if (row.pass) console.log(line);
    else console.error(`${line}   expected ${row.expected}`);
  }
  for (const p of r.problems) console.error(`FAIL  ${p}`);
  if (r.ok) {
    console.log("policy:check ok · safe denies 5/5 malicious and allows 5/5 benign; permissive allows 10/10 · app-level enforcement (orchestrator), not an Otari Agent Guardrail");
    return 0;
  }
  console.error("policy:check failed");
  return 1;
}

try {
  process.exit(main());
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
}
