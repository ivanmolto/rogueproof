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

## Still to come

| Step | File | Task |
|---|---|---|
| Routing policies `agent-primary`, `dev-primary` | `routing/` | 1.2 |
| Fallback test workspace `rogueproof-fallback-test` | `routing/fallback-test.md` | 1.2 |
| Inference guardrail | `guardrails/` | 1.6 |
| Collector MCP server registration | `mcp/collector.json` | 3.2 |
| Code execution tool | `tools/code-execution.json` | 5.1 |
