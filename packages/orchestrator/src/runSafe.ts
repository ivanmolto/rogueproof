// pnpm run:safe [--golden] [--n <number>] [--agent-model A|B|C]
//
// Agent Zero, Safe mode: the agent loop on the service key with end user
// `safe-run-<n>`, the deterministic tool policy in policies/safe/ (app-level
// enforcement in the orchestrator, by design — not an Otari Agent Guardrail),
// the judge gate, and Otari's mandated inference guardrail on every call.
// Needs `pnpm honeypot`, `pnpm collector` and `pnpm tunnel` running, and Docker.
// Output: runs/<timestamp>-safe/{log.txt, run.json, REPORT.md, records.jsonl}.
// `--golden` (MODEL_PROFILE=rubric only) also writes a redacted run.json and log
// to runs/golden/safe/. Never prints a key. The command itself is run/cli.ts.
import { mainCli } from "./run/cli.js";

mainCli("safe");
