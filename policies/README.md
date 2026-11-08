# policies/

Deterministic tool-policy rules evaluated by the orchestrator
(`packages/orchestrator/src/policy/`) before any local tool runs.

**App-level enforcement (orchestrator), by design — not an Otari Agent
Guardrail.** The mandated inference guardrail is Otari's and applies in all
modes. Models never decide whether an action is blocked.

| Mode | Folder | Rules (task 3.5) |
|---|---|---|
| Safe | `safe/` | Deny `.env` / `*.pem` / `*.key` reads and network clients in `run_command`; allow everything else. |
| Permissive | `permissive/` | Empty rule set: allow all. Runs only inside the no-egress sandbox with fake secrets. |
