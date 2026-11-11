# Routing policies (R1)

Three fallback policies in workspace `rogueproof`, created in the dashboard on 2026-11-10 (`docs/evidence/day1/routing-policies.webp`). A policy name is sent as `model`; the response echoes the name and `Otari-Provider` / `Otari-Model` say who answered. `Otari-Fallback: true` and `Otari-Attempt-Count` > 1 mark a rescued call.

| Policy | Main | Backups | Used by |
|---|---|---|---|
| `agent-primary` | DeepSeek V4.1 Flash on Together (own key) | same model on Fireworks → MiniMax M3.1 Flash on Fireworks | agent, agent-capped, agent-service (rubric) |
| `report-primary` | Qwen 3.5 35B A3B on DeepInfra | MiniMax M3.1 Flash on Fireworks | report (rubric) |
| `dev-primary` | Claude Sonnet 4.5 on anthropic-dev | Claude Haiku 5.5 on anthropic-dev | every role (dev) |

The rubric judge does not use a policy: it sends `fireworks:minimax/minimax-m3.1-flash` (model C) directly, so it has no fallback. Model B, first in `report-primary`, needed 4096 tokens and about 90 s per explanation (decision 002). If C is unavailable, the denial stands without an explanation.

`report-primary` was created as `judge-primary` and renamed in the dashboard on 2026-11-11 (policy page → Name → Rename); runs recorded before that show the old name in `model`.

Policy names cannot contain `:` or `/`. Policies are per workspace: `rogueproof-fallback-test` carries its own `agent-primary` for the invalid-key recipe (`fallback-test.md`).

What triggers a backup (dashboard text): the main model fails or is unavailable before it starts answering, including a rate limit, a missing or rejected provider key, or a request it refuses as invalid. Not once the answer has started streaming or a tool call is under way, and not when the remaining budget cannot cover a pricier backup.
