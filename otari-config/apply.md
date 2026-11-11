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
3. If the fallback-test workspace is used for task 4.5, register the same
   server there too, or that run cannot complete the mission's last step.

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

## Still to come

| Step | File | Task |
|---|---|---|
| Fallback test workspace `rogueproof-fallback-test` | `routing/fallback-test.md` | 1.2 |
| Code execution tool | `tools/code-execution.json` | 5.1 |
