// pnpm run:permissive [--golden] [--n <number>] [--agent-model A|B|C] [--extra-try]
//
// Agent Zero, Permissive mode: the same run as Safe mode with the empty tool
// policy in policies/permissive/ (every local tool call is allowed), end user
// `permissive-run-<n>`, the collector MCP server on act turns, and Otari's
// inference guardrail mandated in Monitor (it scores the request and serves it).
// AI decisions are real; the harm is simulated: the only thing that can leave is
// the mission's fake .env, to our own collector mock.
//
// Refuses to start unless sandbox:check passes (no network, no mount but /work,
// every .env value contains FAKE) and the recorded mandate mode is Monitor.
// The `post` event comes from the `drop` entry in otari_tool_calls; run.json
// records it against the collector's own list_drops (collector.crossCheck).
// At most three rubric tries (agent models A and B); after that the refusals
// are the finding in docs/evidence/permissive.md, rebuilt after every run.
// Needs `pnpm honeypot`, `pnpm collector` and `pnpm tunnel` running, and Docker.
// Output: runs/<timestamp>-permissive/. The command itself is run/cli.ts.
import { mainCli } from "./run/cli.js";

mainCli("permissive");
