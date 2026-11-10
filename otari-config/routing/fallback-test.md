# Fallback recipe (R1): the team's official way to see `Otari-Fallback: true`

Workspace `rogueproof-fallback-test` (created 2026-11-10), key `fallback-test`
(`OTARI_API_KEY_FALLBACK_TEST`, $0.50), its own `agent-primary` policy identical to
the one in `rogueproof`, and an organization provider key `together-invalid`
(provider `together`, deliberately bad value, never the org default).

## Steps

1. Workspaces → `rogueproof-fallback-test` → Providers → expand **together** →
   `…` on `together-invalid` → **Always use this key**. Wait a few seconds.
2. Send `model: "agent-primary"` with the `fallback-test` key:
   ```
   curl -sS -D - "$OTARI_BASE_URL/chat/completions" \
     -H "Authorization: Bearer $OTARI_API_KEY_FALLBACK_TEST" -H "Content-Type: application/json" \
     -d '{"model":"agent-primary","messages":[{"role":"user","content":"hello"}],"max_tokens":16}'
   ```
3. Read the headers: `Otari-Fallback: true`, `Otari-Attempt-Count: 2`,
   `Otari-Provider: fireworks` (the first backup), `Otari-Model:
   accounts/fireworks/models/deepseek-v4p1-flash`. The body's `model` still says
   `agent-primary`. The Requests view shows both attempts under one request id.
4. **Restore**: same `…` menu → **Reset** (the dashboard's wording; the plan's
   "Follow the organization" state). "Stop always using this key" would leave the
   invalid key enabled as one candidate, so use Reset. Verify a new call answers
   with `Otari-Provider: together`, `Otari-Attempt-Count: 1`.

## Recorded run (2026-11-10 23:0x UTC+1)

| Call | Provider | Attempts | Fallback | Request id |
|---|---|---|---|---|
| before pin | together | 1 | false | 5d80d2a4-32a5-45b3-9f89-96f100ab691c |
| after pin, 1st | together | 1 | false | ab6f8f22-e90c-4f62-9677-3d61404bc935 (pin not yet effective) |
| after pin, 2nd | **fireworks** | **2** | **true** | c87c21d3-dcfb-4dae-ab45-13ba402c33f6 |
| after Reset | together | 1 | false | see `restored.headers` |

Headers saved in `docs/evidence/day1/fallback-recipe/`. The Requests view (`requests-both-attempts.webp`) lists the rescued request as two rows: the Together attempt with status **Absorbed** (no tokens, no cost, 448 ms) and the Fireworks attempt with status Success (37+16 tokens, $0.00003, 1.15 s), both under routing `agent-primary`. Cost per call $0.00003.
`run:safe --fallback-demo` (task 4.5) automates steps 2–3 and reminds the operator to do 4.
