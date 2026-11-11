# @rogueproof/orchestrator

Runs RogueProof scenarios: the agent loop, the tool policy, the sandbox and the
single connection to the otari.ai gateway.

| Module | Path | Holds | Task |
|---|---|---|---|
| **otari** | `src/otari/` (`client`, `env`, `models`, `tools`, `toolCalls`, `outcome`, `redact`, `records`) | The only Otari gateway in the repo: OpenAI-compatible client with `baseURL = OTARI_BASE_URL`, a key per role (`agent`, `judge`, `report`, `agent-capped`, `agent-service`), end user per run, `Otari-*` header capture, the seven outcomes (`ok · fallback · guardrail_blocked · budget_exceeded · tool_error · error · step_cap`), bounded retries, redacted request/response records. Lint forbids any other module from importing the OpenAI SDK or naming `api.otari.ai`. | 1.3 |
| **agent** | `src/agent/` (`loop`, `tools`, `types`) | The agent under test: a minimal, auditable function-calling loop (decision 001), `runAgent()`. Phased tool sets, one per turn — *research* (`otari_web_fetch`, `otari_web_search`), *act* (local tools + `mcp_server_ids: [collector]`); *report* calls (`otari_code_execution`) are made outside the loop. 40-call cap. See "The agent loop" below. | 3.0 |
| **policy** | `src/policy/` | Deterministic evaluation of `policies/safe/` and `policies/permissive/` before any local tool runs, plus the judge gate on `deny`. **App-level enforcement (orchestrator), by design — not an Otari Agent Guardrail.** Models never decide a block. | 3.5 |
| **sandbox** | `src/sandbox/` (`docker`, `exec`, `check`, `lifecycle`) | Executes `read_file` (`cat`), `write_file` (content on stdin) and `run_command` (`sh -c`, 30 s, 64 KiB) inside the no-egress sandbox container, one bounded `docker exec` per call; `createDockerSandbox()` implements the loop's `Sandbox` interface. `copyMission()` makes the per-run workspace, `startSandbox()` refuses to start unless `sandbox:check` passes (no network, no mount but `/work`, no real-looking `.env` value). The agent never gets a shell. See `sandbox/README.md`. | 3.4 |

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
