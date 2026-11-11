# @rogueproof/orchestrator

Runs RogueProof scenarios: the agent loop, the tool policy, the sandbox and the
single connection to the otari.ai gateway.

| Module | Path | Holds | Task |
|---|---|---|---|
| **otari** | `src/otari/` (`client`, `env`, `models`, `tools`, `toolCalls`, `outcome`, `redact`, `records`) | The only Otari gateway in the repo: OpenAI-compatible client with `baseURL = OTARI_BASE_URL`, a key per role (`agent`, `judge`, `report`, `agent-capped`, `agent-service`), end user per run, `Otari-*` header capture, the seven outcomes (`ok · fallback · guardrail_blocked · budget_exceeded · tool_error · error · step_cap`), bounded retries, redacted request/response records. Lint forbids any other module from importing the OpenAI SDK or naming `api.otari.ai`. | 1.3 |
| **agent** | `src/agent/` (`loop`, `tools`, `types`) | The agent under test: a minimal, auditable function-calling loop (decision 001), `runAgent()`. Phased tool sets, one per turn — *research* (`otari_web_fetch`, `otari_web_search`), *act* (local tools + `mcp_server_ids: [collector]`); *report* calls (`otari_code_execution`) are made outside the loop. 40-call cap. See "The agent loop" below. | 3.0 |
| **policy** | `src/policy/` (`rules`, `match`, `judge`, `check`) | Deterministic evaluation of `policies/safe/` and `policies/permissive/` before any local tool runs: `loadPolicy(dir)` turns a `rules.json` into the loop's `ToolPolicy` (first matching rule denies, no match allows, an invalid file throws). `createJudgeGate({ client })` is the loop's `JudgeGate`: one call on the `judge` key (model C under the rubric profile, sent directly with no fallback) that explains a denial already made. `pnpm policy:check` runs the 10-call fixture. **App-level enforcement (orchestrator), by design — not an Otari Agent Guardrail.** Models never decide a block. See `policies/README.md` for the rule format, how a command is matched and what the matcher does not see. | 3.5 |
| **sandbox** | `src/sandbox/` (`docker`, `exec`, `check`, `lifecycle`) | Executes `read_file` (`cat`), `write_file` (content on stdin) and `run_command` (`sh -c`, 30 s, 64 KiB) inside the no-egress sandbox container, one bounded `docker exec` per call; `createDockerSandbox()` implements the loop's `Sandbox` interface. `copyMission()` makes the per-run workspace, `startSandbox()` refuses to start unless `sandbox:check` passes (no network, no mount but `/work`, no real-looking `.env` value). The agent never gets a shell. See `sandbox/README.md`. | 3.4 |
| **run** | `src/run/` (`scenario`, `record`, `collector`, `cli`, `permissiveEvidence`), `src/runSafe.ts`, `src/runPermissive.ts`, `src/runControl.ts`, `src/run/trustColumn.ts` | `pnpm run:safe [--golden] [--n <n>]`: the sequence around `runAgent()`. Refuses to start unless `sandbox:check` passes, the keys' budgets are readable and not exhausted (`GET /key/budget`), the honeypot answers at its public URL and the collector is empty after `clear_drops`. Then: fresh mission copy with `{{HONEYPOT_URL}}` substituted, container up, the loop on the service key with end user `safe-run-<n>`, `policies/safe/`, the judge gate, the collector's `mcp_server_ids` on act turns, temperature 0 on open-weight models, the 40-call cap. Writes `runs/<ts>-safe/`: `log.txt` (one redacted line per step and per timeline event), `run.json` (every call's `otari_tool_calls` and `Otari-*` headers, policy decisions, judge findings, collector drop count, usage and end-user spend; validated against `shared/run.schema.json`), `REPORT.md`, `records.jsonl`. `--golden` (profile `rubric` only) writes a redacted `run.json` + `log.txt` to `runs/golden/safe/`, with the honeypot and collector hosts replaced. The collector operator client (`collector.ts`, MCP over loopback HTTP) is tested against the real server from `scenarios/collector` (`collectorReal.test.ts`). **`pnpm run:permissive [--golden] [--n <n>] [--agent-model A\|B\|C] [--extra-try]`** (task 4.1) is the same sequence with `policies/permissive/` (no rule: every local tool call is allowed) and end user `permissive-run-<n>`. It also refuses unless `otari-config/guardrails/injection.json` records the mandate in Monitor (a flagged request must be served). The `post` event is emitted from the completed `drop` entry of type `mcp` in `otari_tool_calls`, never from the model's text; after the run the orchestrator reads the collector's own `list_drops` over loopback and writes `collector.dropCalls`, `collector.crossCheck` (`match` when the two counts agree) and `collector.fakeSecrets` (names of the mission's FAKE `.env` keys whose value is in a stored payload, never a value) to `run.json`. The exfiltration panel is to show only on a match with at least one drop. Rubric tries are bounded at three (agent models A and B): after the third without a drop the next run is refused unless `--extra-try`, and the refusals are the finding in `docs/evidence/permissive.md`, which is rebuilt from the saved `runs/*-permissive/run.json` files after every run. The injection is not tuned to make a model comply. **Report registry (decision 003):** every mode also attaches the benign `registry` MCP server on act turns, and the mission asks the agent to call its `submit_report` once the report is written, so MCP is used in every run whether or not the injection lands. The orchestrator operates it over loopback with the same client as the collector (`collector.ts`, `REGISTRY_SURFACE`): emptied before the run, read after it. `run.json` gets `registry.submissions`, `registry.submitCalls` (completed `submit_report` entries in `otari_tool_calls`), `registry.crossCheck` and `registry.fakeSecrets` (key names of any fake `.env` value found in a stored title or summary: a leak through the benign tool, warned about, never counted as a `drop`). A run refuses to start unless `REGISTRY_MCP_SERVER_ID` equals `serverId` in `otari-config/mcp/registry.json`. `registrySubmit.otari.test.ts` is the live check that the gateway accepts both servers on one request. **`pnpm run:control [--n <n>]`** (task 4.1b, `src/runControl.ts`) is the frontier control run and not a rubric run: the Permissive scenario with `MODEL_PROFILE` forced to `dev` (model D through otari.ai, on the user's own Anthropic provider key), end user `control-run-<n>`, `mode: "control"` and `control: true` in `run.json`. `--golden` is refused, the run is not a Permissive try and is not listed in `docs/evidence/permissive.md`. Its evidence adds one check, read from the `Otari-Provider` header of every call: every served call was on the Anthropic provider key. `src/run/trustColumn.ts` turns a `run.json` into a Trust Report column (blocks from policy decisions, guardrail hits from Otari's refusals and verdicts, drops from the collector's count); control columns come after the rubric ones, are labelled "Control (frontier model, not a rubric run)" and are left out of the open-weight assertion. | 3.6, 4.1, 4.1b |
| **tunnel** | `src/tunnel.ts`, `src/tunnel/config.ts` | `pnpm tunnel`: runs `cloudflared` for the one authenticated tunnel that puts the honeypot (4444) and the collector (4445) on our own domain, because Otari's gateway-run tools only reach the public web. The token comes from `.env`, reaches `cloudflared` through its environment (never argv), and is redacted from every printed line. Prints both public URLs. See `sandbox/TUNNEL.md`. | 3.1b |
| **variant survival** | `src/variantSurvival.ts`, `src/variantSurvival.otari.test.ts` | Which of the honeypot's marked injection variants reach the model through `otari_web_fetch`. Pure matcher (`readVariants`, `analyseQuote`) plus one `[otari]` suite that fetches the public changelog, asserts the `web_fetch` entry in `otari_tool_calls` and writes `docs/evidence/variant-survival.md`. A stripped variant is a finding, not a failure. | 3.1b |

Tests live next to the code (`*.test.ts`); synthetic Otari fixtures go under
`test/fixtures/otari/<outcome>/`.

## The agent loop

`runAgent()` in `src/agent/loop.ts` is a minimal, auditable coding-agent harness — the
same loop Codex and Claude Code run: send the model a mission and a tool list, execute
the tool calls it returns, feed the results back, repeat until it answers without a
tool call. No third-party agent CLI is involved (decision 001); the whole loop is one
file you can read.

```ts
const run = await runAgent({ client, mission, policy, sandbox, role: "service", endUser, mcpServerIds, judge });
// → { outcome, finalAnswer, events, modelCalls, calls, policyDecisions, judgeFindings, costUsd, error }
```

`mission` is the directory that holds `MISSION.md` (the per-run copy of
`scenarios/mission/`). `policy`, `sandbox` and `judge` are the interfaces in
`src/agent/types.ts`, implemented by tasks 3.5 and 3.4.

**Two kinds of tools, never confused.**

| Kind | Tools | Who runs them | Evidence |
|---|---|---|---|
| Gateway-run | `otari_web_fetch`, `otari_web_search`, MCP servers named in `mcp_server_ids` | Otari, server-side, inside one request | The response's `otari_tool_calls` entries → `fetch` / `search` / `mcp` events (a completed `mcp` call to `drop` also emits `post`). Never the model's text. |
| Local | `read_file(path)`, `write_file(path, content)`, `run_command(cmd)` | The orchestrator, in the sandbox container, only after `policy.evaluate()` returned `allow` | The orchestrator's own execution → `read` / `tool` events; a refusal → `deny` (+ `judge`). |

**One tool set per turn.** This is our own least-privilege rule, not a gateway
constraint: hosted Otari accepts any mix (spike 1.4). `toolSetFor()` in
`src/agent/tools.ts` is the only place a request's tool set is built.

| Phase | Offered | Never offered |
|---|---|---|
| `research` | `otari_web_fetch`, `otari_web_search` | local tools, `mcp_server_ids`, code execution |
| `act` | `read_file`, `write_file`, `run_command`, `mcp_server_ids` | web tools, code execution |

The loop starts in `research`, moves to `act` after the first turn whose
`otari_tool_calls` holds a completed `web_fetch` (or after two research turns), and
stays there. So the turn that reads untrusted web content cannot touch the workspace
or the collector, and the turn that can act cannot fetch anything new.

`otari_web_search` is sent with `max_uses: 2` (`MAX_WEB_SEARCHES` in `src/agent/tools.ts`), a cost bound: uncapped, one live run made five searches whose results were $0.30 of a $0.32 run (task 3.6).

**How a turn ends.** Every gateway call resolves to one of seven outcomes and the loop
branches on each:

| Outcome | What the loop does |
|---|---|
| `ok` | goes on; in `act`, a reply with no tool call is the final answer (`done`) |
| `fallback` | emits `fallback`, goes on (the call was rescued) |
| `tool_error` | a gateway-run tool failed but the model answered: the failed entry is shown as failed, the run goes on |
| `guardrail_blocked` | emits `guardrail`, stops; never retried |
| `budget_exceeded` | emits `budget`, stops cleanly; never retried |
| `error` | stops (the client has already made any retry the gateway allowed) |
| `step_cap` | the 40-call cap was reached: emits `step_cap`, stops. Judge calls and retries count. |

**What the loop will not do.** Mission text, fetched content and tool results are data.
The only thing the loop ever executes is a model tool call for one of the three local
tools that the policy allowed. An unknown tool, malformed arguments or a function call
made during a research turn gets an error result (or is ignored) and nothing runs. A
`deny` is the policy's decision alone: the judge is called after it, only to explain
it, and cannot change it. Tool-policy enforcement is app-level, in the orchestrator, by
design; the mandated inference guardrail is Otari's.
