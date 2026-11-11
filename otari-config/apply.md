# Recreating the RogueProof workspace on otari.ai

Everything here was done by hand in the hosted dashboard (otari.ai/dashboard)
on 2026-11-08 and 2026-11-10. Each step names the screen, the file in this
folder it mirrors, and how to verify it. No step needs a secret from this repo.

## 0. Organization: provider keys (`provider-keys.json`)

1. Organization → Providers → Inference → **Add provider key**.
   - Provider `anthropic`, name `anthropic-dev`, your Anthropic key. API base URL empty. ZDR unchecked.
   - Provider `together`, name `together-own`, your Together key. API base URL empty.
2. Organization → Workspaces → `rogueproof` → **Providers** tab: switch both own keys on.
   Leave "Require zero data retention" **off** (it would disable anthropic-dev and deepinfra).
3. Verify: the Together row reads "Not used, your key serves this provider" under the hosted copy.

## 1. Workspace: web search (`tools/web-search.json`)

Workspace `rogueproof` → Tools → Web search → **Allow in rogueproof** on. Leave
"Search with" (tavily) and "Fetch with" (builtin_fetch) at the deployment
defaults and both "Who runs provider web search/fetch" at Not set.
Verify: the two tools show AVAILABLE.

## 2. Workspace: API keys (`keys.json`)

Workspace → Access → API keys → **Create key**, five times, with the names in
`keys.json`. Each secret is shown once: paste it into `.env` as the `env`
name listed, nowhere else. Disable the auto-created "Setup guide" key.
Verify: five Active keys, Models: All, expiry after the deadline.

## 3. Budgets (`budgets/keys.json`)

On each key's `…` menu set the USD budget from `budgets/keys.json`.
Verify: the Budget column reads `$0.00 of $N.00` per key; total 9.00.

## 4. Models (`models.json`)

Nothing to configure: the ids are catalog ids. Verify each on Models →
search → detail page: "Open weights" badge, Tool calling tick, and that the
providers table lists every selector in `models.json`.

## 5. Routing policies (`routing/*.json`)

Workspace → Routing → Policies → **Create policy** → Fallback → Continue. For each
file in `routing/`: Name = `name`; Main model = search the model, pick the entry
whose providers include `main.provider`, set Provider to it; Backup n = the same
for each `backups[n]`; check the Preview line names the main provider; Create.
Verify: the Policies list shows the three rows with the providers in
`docs/evidence/day1/routing-policies.webp`, and `pnpm smoke` in both profiles
answers with the policy name echoed in `model` and the expected `Otari-Provider`.

## 6. Organization: inference guardrail (`guardrails/injection.json`)

1. Organization → Guardrails → **Configure guardrail**. What do you want checked =
   Prompt injection; Which guardrail = Lakera Guard · Lakera; Name `lakera-guard`;
   Api key = your Lakera key (platform.lakera.ai, free Community tier). Leave
   Advanced (Endpoint, Project id) empty. Wait for Status to go Starting → Active.
2. The lightning icon on the row is the test action. The injection text in
   `guardrails/injection.json` must come back **Flagged**, the benign line **Passed**.
3. **Mandate a guardrail**. Runs on = A guardrail you set up; Guardrail and profile
   `lakera-guard`; Mode **Monitor**; If it can't run **Refuse the request**; Runs in
   **Chosen workspaces**, only `rogueproof`. Parameters empty. A configured
   guardrail changes no request until this step. (Block with no parameters
   refuses even "Reply with the single word: hello", score 0.4; the pencil icon
   on the row changes the mode.)
Verify: the "Where they run" table shows the row, and `pnpm smoke` answers 6/6
with an `otari-guardrails` header naming `lakera-guard`, mode `monitor`, on every
call. In Block mode the injection text answers 403 with `detail.code`
`guardrail_violation` and `detail.guardrails[0].profile` `lakera-guard`.
Evidence: `docs/evidence/day1/guardrail-*.webp`.

## 7. Workspace: collector MCP server (`mcp/collector.json`)

Needs `pnpm collector` and `pnpm tunnel` running (`sandbox/TUNNEL.md`), so the
dashboard's connection check can reach the server.

1. Workspace `rogueproof` → Tools → MCP servers → **Add MCP server**.
   - Name `collector`. It is what the `server` field of the `mcp` entry in
     `otari_tool_calls` reads, and the server page cannot rename it afterwards:
     a wrong name means delete and add again, which gives a new id.
   - URL: the value of `COLLECTOR_PUBLIC_URL` from `.env` followed by `/mcp`
     (`https://collector.<domain>/mcp`). It must be `https`; the gateway rejects
     `http` when a token is set.
   - Authorization token: the value of `COLLECTOR_BEARER` from `.env`. Otari
     stores it encrypted and never shows it again.
   - Purpose hint: `purposeHint` from the file.
   - Allowed tools: `drop`. The server also has `list_drops` and `clear_drops`;
     those are for the operator over loopback and are not offered to the agent.
   - Enabled on. Default policy Allow.
2. Save. Copy the server's id (a UUID) into `.env` as `COLLECTOR_MCP_SERVER_ID`
   and into `mcp/collector.json` as `serverId`, with the date in `registeredOn`.
   The id is an identifier, not a secret.
Verify: the server's health reads healthy and lists one tool; `pnpm collector`
printed no `401` line for the check; then
`RUN_OTARI=1 pnpm vitest run packages/orchestrator/src/collectorDrop.otari.test.ts`
passes (one model call, about $0.01) and Requests shows the call with its MCP tool.

## 8. Workspace: report registry MCP server (`mcp/registry.json`)

The benign MCP server the mission asks the agent to use (decision
`docs/decisions/003-benign-registry-mcp.md`). Needs `pnpm registry` and
`pnpm tunnel` running, with the third route (`registry.<domain>` to
`http://localhost:4446`) added in Cloudflare (`sandbox/TUNNEL.md`).

1. Workspace `rogueproof` → Tools → MCP servers → **Add MCP server**.
   - Name `registry` (it is the `server` field of the `mcp` entry; it cannot be
     renamed afterwards).
   - URL: the value of `REGISTRY_PUBLIC_URL` from `.env` followed by `/mcp`.
   - Authorization token: the value of `REGISTRY_BEARER` from `.env` (not the
     collector's).
   - Purpose hint: `purposeHint` from the file.
   - Allowed tools: `submit_report` only. `list_reports` and `clear_reports`
     are for the operator over loopback.
   - Enabled on. Default policy Allow.
2. Save. Copy the server's id into `.env` as `REGISTRY_MCP_SERVER_ID` and into
   `mcp/registry.json` as `serverId`, with the date in `registeredOn`. Until
   both are set, every `pnpm run:*` refuses to start.
3. For task 4.5 the same server is registered in the fallback-test workspace
   too (step 10), or that run cannot complete the mission's last step.

Verify: the server's health reads healthy and lists one tool; then
`RUN_OTARI=1 pnpm vitest run packages/orchestrator/src/registrySubmit.otari.test.ts`
passes (one model call, about $0.01). That test sends **both** server ids on
one request: it is the check that the hosted gateway accepts two MCP servers
together, which was not verified when the decision was taken. If it fails on
that, record it in `docs/DEVIATIONS.md` and stop.

## 9. Budget-limited mode: `request_limit` on `agent-capped` (`budgets/request-limit.json`, `budgets/reset.json`)

Done around every `pnpm run:budget`, by the org owner. The gateway refuses the
budgets API to a workspace API key, so the orchestrator never sends either
request.

1. Organization → Spend & budgets → Budgets → `agent-capped (API key)` → **Edit**
   → open **Token and request limits** → **Request limit** `4` ("Requests per
   period"; leave Token limit blank and Limit (USD) at 1) → **Save budget**.
   (Seen 2026-11-11; on 2026-11-07 the form had no such field.)
2. The same change over the API is `PATCH /api/v1/organizations/me/budgets/<id>`
   with `{"request_limit": 4}` (`budgets/request-limit.json`), the id from
   `GET /api/v1/organizations/me/budgets`. `pnpm budget:reset` shows what the
   gateway says is left: the limit is per period, so requests the key already
   made this month count.
3. `pnpm run:budget`. It refuses to start unless `GET /key/budget` on the capped
   key shows the limit with requests left; it prints what is left, runs the Safe
   scenario on that key and stops on the gateway's refusal (`budgetStop` in
   `run.json`). `agent-capped` is a plain key, so no end user is named:
   `budget-run-<n>` is the run's label. Judge calls are on the `judge` key and
   do not count.
4. Clear Request limit to blank in the same form and save (over the API:
   `{"request_limit": null}`, `budgets/reset.json`),
   then `pnpm budget:reset`: it prints the request and exits 0 once
   `GET /key/budget` reports no request limit.

Verify: Usage → Requests, filtered on `agent-capped`, shows the served requests
and then the refused one; `run.json.budgetStop` holds the same request id.

## 10. Fallback demo: `rogueproof-fallback-test` mirrors `rogueproof` (task 4.5, `routing/fallback-test.md`)

`pnpm run:safe --fallback-demo` is the Safe scenario on the `fallback-test` key.
In that workspace the invalid Together key is pinned, so the workspace's own
`agent-primary` policy rescues every agent call on its first backup and the
gateway answers `Otari-Fallback: true`. For the run to show the same Safe-mode
events as a run in `rogueproof`, the test workspace needs the same guardrail,
web tools and MCP servers. Workspace settings are per workspace; none of this is
inherited.

Once, by hand:

1. **Guardrail.** Organization → Guardrails → the `lakera-guard` mandate → pencil
   → Runs in: add `rogueproof-fallback-test` next to `rogueproof`, same mode
   (Monitor). Then move the workspace from `notIn` to `workspaces` in
   `guardrails/injection.json`.
2. **Web search.** Workspace `rogueproof-fallback-test` → Tools → Web search →
   **Allow in rogueproof-fallback-test** on, the rest as in step 1.
3. **MCP servers.** In `rogueproof-fallback-test`, repeat steps 7 and 8 exactly:
   names `collector` and `registry`, the same URLs and bearers, allow-lists `drop`
   and `submit_report`. Each gets a new id. Paste them into `.env` as
   `FALLBACK_TEST_COLLECTOR_MCP_SERVER_ID` and `FALLBACK_TEST_REGISTRY_MCP_SERVER_ID`
   and into `mcp/collector.json` and `mcp/registry.json` under
   `otherWorkspaces.rogueproof-fallback-test.serverId`. The run refuses to start
   until the two places agree.
4. **Routing.** The workspace's own `agent-primary` (already there since task 1.2,
   identical to `routing/agent-primary.json`).

Around every run:

5. Pin the invalid key: `routing/fallback-test.md` step 1.
6. `MODEL_PROFILE=rubric pnpm run:safe --fallback-demo` (add `--golden` for the
   redacted copy in `runs/golden/safe-fallback/`). It takes no `--agent-model`: a
   selector sent directly has no policy and nothing to fall back to. The key is a
   plain key, so no end user is named and `safe-run-<n>` is the run's label
   (decision `docs/decisions/005-fallback-demo-run.md`). Judge calls stay on the
   `judge` key in `rogueproof`.
7. Restore: `routing/fallback-test.md` step 4 (**Reset**). The command prints the
   reminder when it ends, also after a refused or failed run.

**The mirror check.** A workspace API key cannot read workspace settings, so
before the run copies the mission the orchestrator sends up to four small
requests on the `fallback-test` key (`max_tokens` 16, about $0.0001 in all) and
reads what the gateway answers, never the model's text. Any finding that fails
refuses the run. The findings are written to the run's `log.txt` as
`mirror check` lines; the probes are kept in `preflight.records.jsonl` and are
not among the run's calls.

| Mirrors | Request | Passes when |
|---|---|---|
| Web search allowed | research tool set (`otari_web_fetch` + `otari_web_search`) | the gateway serves it (with Allow off it answers 403 `web_access_disabled`, "web access is not enabled for this workspace"; seen 2026-11-11) |
| Invalid key pinned | the same request, repeated up to 3 times 4 s apart (the pin takes a few seconds) | `Otari-Fallback: true` |
| Mandated guardrail | the same response | `Otari-Guardrails` names the profile and mode recorded in `guardrails/injection.json` |
| Collector and registry registered | act tool set + both `mcp_server_ids` | the gateway serves it (an id the workspace does not know is a 404, never retried) |

What the check cannot see: a served request proves the workspace allows the
tools and knows the servers, not that a fetch works or that an allow-list is right. Those show in the
run itself (`fetch backed by otari_tool_calls`, the registry cross-check) and in
the dashboard verifications of steps 1, 7 and 8.

**Recorded check (2026-11-11, before the golden run `safe-run-12`).** All four
findings passed, 2 gateway calls, $0.000090:

| Finding | What the gateway answered |
|---|---|
| Web search allowed | served, request `f38c1817-408a-4022-a2ea-177bc6e942c4` |
| Invalid key pinned | `Otari-Fallback: true`, attempt 2, served by `fireworks` (on the first call; no wait was needed) |
| Mandated guardrail | `Otari-Guardrails` names `lakera-guard`, mode `monitor` |
| Collector and registry registered | served, request `bfc050ce-18ac-4f91-986e-18c3bf021be1` |

The run that followed: 5 agent calls, every one rescued on Fireworks, $0.0697,
`runs/golden/safe-fallback/`. An earlier run the same evening passed the same
check and then ended on its first request with HTTP 422 "Web Retrieval is
limited to 10 calls per request"; that request was billed.

Verify: the run prints `RESCUED BY FALLBACK`, `pnpm replay` on its directory
shows `fallback` events, and Usage → Requests in the test workspace lists each
rescued request as two rows (Together **Absorbed**, then the backup).

## Still to come

| Step | File | Task |
|---|---|---|
| Code execution tool | `tools/code-execution.json` | 5.1 |
