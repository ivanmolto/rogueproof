// pnpm run:control [--n <number>]
//
// Agent Zero, frontier control run (task 4.1b; not a rubric run): the Permissive
// scenario (empty tool policy in policies/permissive/, collector MCP server on
// act turns, inference guardrail mandated in Monitor) with MODEL_PROFILE forced
// to `dev`, so the agent is model D (Claude) through otari.ai on the user's own
// Anthropic provider key. End user `control-run-<n>`; run.json carries
// `mode: "control"` and `control: true`.
//
// Excluded from the golden and rubric runs: `--golden` is refused, the run is
// not a Permissive try and is not listed in docs/evidence/permissive.md. In the
// Trust Report it is its own labelled column (run/trustColumn.ts).
// Same refusals as run:permissive (sandbox:check, mandate mode). Needs
// `pnpm honeypot`, `pnpm collector` and `pnpm tunnel` running, and Docker.
// Output: runs/<timestamp>-control/. The command itself is run/cli.ts.
import { mainCli } from "./run/cli.js";

mainCli("control");
