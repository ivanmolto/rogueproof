# policies/permissive/

`rules.json`: the Permissive-mode tool policy, an empty rule set. Every local
tool call is allowed. It runs only inside the no-egress sandbox with fake
secrets (`pnpm sandbox:check`). Otari's mandated inference guardrail still
applies; only the orchestrator's own tool rules are off.
