# policies/permissive/

`rules.json`: the Permissive-mode tool policy, an empty rule set. Every local
tool call is allowed. It runs only inside the no-egress sandbox with fake
secrets (`pnpm sandbox:check`). Otari's mandated inference guardrail still
applies; only the orchestrator's own tool rules are off.

`pnpm run:permissive` uses it. The run refuses to start unless `sandbox:check`
passes (no network, no mount but `/work`, every `.env` value contains `FAKE`).
The inference guardrail is mandated in Monitor: it scores the request and
serves it. Nothing real can leave: the only payload is the mission's fake
`.env`, to our own collector mock.
