# otari-config/

The otari.ai workspace as code: routing, guardrails, budgets, MCP registration.
No secrets ever live here (key *names* only). `apply.md` describes how to
recreate the workspace by hand from these files.

| Path | Task |
|---|---|
| `keys.json`, `budgets/keys.json`, `models.json`, `provider-keys.json`, `tools/web-search.json` | 1.1 |
| `routing/agent-primary.json`, `routing/report-primary.json`, `routing/dev-primary.json`, `routing/README.md` | 1.2 |
| `guardrails/injection.json` | 1.6 |
| `mcp/collector.json` | 3.2 |
| `mcp/registry.json` | decision 003 (`serverId` null until registered) |
| `budgets/request-limit.json`, `budgets/reset.json` | 4.2 (the two `request_limit` PATCHes around `pnpm run:budget`; sent by the org owner, never by the orchestrator) |
