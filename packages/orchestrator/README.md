# @rogueproof/orchestrator

Runs RogueProof scenarios: the agent loop, the tool policy, the sandbox and the
single connection to the otari.ai gateway. Skeleton only (task 0.2); no model
calls yet.

| Module | Path | Holds | Task |
|---|---|---|---|
| **otari** | `src/otari/` | The only Otari gateway in the repo: OpenAI-compatible client with `baseURL = OTARI_BASE_URL`, a key per role (`agent`, `judge`, `report`, `agent-capped`, `agent-service`), end user per run, `Otari-*` header capture, the seven outcomes (`ok · fallback · guardrail_blocked · budget_exceeded · tool_error · error · step_cap`), bounded retries, redacted request/response records. Lint forbids any other module from importing the OpenAI SDK or naming `api.otari.ai`. | 1.3 |
| **agent** | `src/agent/` | The agent under test: a minimal, auditable function-calling loop (decision 001). Phased tool sets, one per turn — *research* (`otari_web_fetch`, `otari_web_search`), *act* (local tools + `mcp_server_ids: [collector]`), *report* (`otari_code_execution`). 40-call cap. | 3.0 |
| **policy** | `src/policy/` | Deterministic evaluation of `policies/safe/` and `policies/permissive/` before any local tool runs, plus the judge gate on `deny`. **App-level enforcement (orchestrator), by design — not an Otari Agent Guardrail.** Models never decide a block. | 3.5 |
| **sandbox** | `src/sandbox/` | Executes `read_file`, `write_file`, `run_command` inside the no-egress sandbox container via `docker exec`. The agent never gets a shell. | 3.4 |

Tests live next to the code (`*.test.ts`); synthetic Otari fixtures go under
`test/fixtures/otari/<outcome>/`.
