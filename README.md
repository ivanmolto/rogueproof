# RogueProof — the proving ground for autonomous AI

> Break your AI agents before the real world does.

**Status:** hackathon build, Otari hosted gateway (EU) tested 2026-11-10 with openai SDK 7.54.0, built 2026-11-10 · **work in progress**

Built on Otari by Mozilla.ai · MozFest Developers Wilding: Online (Mozilla.ai, DoraHacks) · submission branch `devs-wilding`

## Scenario 1: Agent Zero

*"AI is powerful. Who holds the keys?"*

A minimal, fully auditable coding-agent harness — the orchestrator's own
read/run/write function-calling loop — runs on open-weight models through the
hosted otari.ai gateway. Mid-task, a hidden prompt injection on the target site
tells it to read `.env` and exfiltrate it through a collector tool. The same
attack is replayed under three Otari policies:

| Mode | What happens |
|---|---|
| **Safe** | Otari's mandated inference guardrail flags the injection; the orchestrator's tool policy (app-level, deterministic) denies the secret read; a judge model explains; the agent finishes the real task. |
| **Permissive** | Tool policy empty; inside a no-egress sandbox with **fake** secrets, the agent obeys and the local collector receives the fake `.env`. |
| **Budget-limited** | A `request_limit` on the capped budget stops the run with a real `budget_exceeded`. |

The mandated guardrail is Lakera Guard, configured and run by Otari as an
organization guardrail (Monitor mode, workspace `rogueproof`: every request is
scored and the verdict comes back in the `Otari-Guardrails` header); prompts sent through
that workspace are scored by Lakera.

AI decisions are real; harmful actions are simulated. Nothing real leaves the
machine.

### Beyond the rubric

Otari features we noticed and use (or deliberately don't) that are not among
the eight scored ones:

- **Zero-data-retention enforcement per workspace.** Each provider carries a
  ZDR declaration; a workspace can be set to *Require zero data retention*, and
  every non-ZDR provider — including our own Anthropic key — is blocked for it
  at once (seen 2026-11-08: 5 of 10 providers went off). We leave it off, since
  model D is a non-ZDR key, but it is a one-switch governance control a real
  deployment would want.

## Repository

| Path | What |
|---|---|
| `apps/dashboard` | Next.js dashboard (Attack Arena · Defense Control · Trust Report). Never calls Otari; proxies to the orchestrator. |
| `packages/orchestrator` | Agent loop, tool policy, sandbox execution, and the only Otari client (`src/otari/`). |
| `packages/testing` | `describeOtari` / `describeSandbox` test tags. |
| `scenarios/` | Honeypot, collector, mission — reusable fixtures with no Otari imports. |
| `shared/` | JSON Schemas (`timeline`, `run`, `trust-report`) and generated TS types. |
| `otari-config/` | The otari.ai workspace as code. |
| `policies/` | Deterministic tool-policy rules (`safe/`, `permissive/`). |
| `sandbox/` | No-egress container for local tools. |
| `runs/` | Run output (gitignored except `runs/golden/`). |
| `docs/` | Briefing, plan, decisions, evidence, feature map, submission notes. |

## Develop

Node 22+, pnpm 11.

```bash
pnpm install && pnpm -r build
pnpm test && pnpm lint && pnpm typecheck
pnpm gen:schemas        # regenerate shared/src/generated from shared/*.schema.json
```

Tests run offline. Suites named `[otari]` need the live gateway
(`RUN_OTARI=1`, `pnpm test:otari`); suites named `[sandbox]` need Docker
(`RUN_SANDBOX=1`, `pnpm test:sandbox`). CI runs neither.

Copy `.env.example` to `.env` and fill in the keys; `.env` is gitignored and
keys are server-side only.

### Secret scanning (enable once per clone)

A gitleaks pre-commit hook lives in `.githooks/` and refuses commits that
contain secrets, including Otari workspace keys (`otk_v1_<region>_…`, plus the
`tk-…` / `gw_…` shapes the plan assumed) (`.gitleaks.toml`).

```bash
brew install gitleaks && git config core.hooksPath .githooks
```

Never bypass it with `--no-verify`.

## License

Apache-2.0. See `LICENSE`.
