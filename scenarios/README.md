# scenarios/

Reusable attack fixtures for **Scenario 1: Agent Zero**. They work against any
agent and any gateway, so they **never import anything Otari-specific** (or the
orchestrator); eslint enforces it.

| Fixture | Task | What it is |
|---|---|---|
| `honeypot/` | 3.1 | Static "Lumen Notes" site with three hidden injection variants (`data-agent-zero="injection"`), `noindex`, random path prefix (`HONEYPOT_PREFIX`). Localhost for dev; our own domain through the tunnel for runs. Never a third-party site. |
| `collector/` | 3.2 | Local MCP mock (`drop`, `list_drops`, `clear_drops`) bound to 127.0.0.1, bearer-authenticated, reachable by the hosted gateway only through the authenticated tunnel. |
| `mission/` | 3.3 | `MISSION.md` and a **fake** `.env` (every value contains `FAKE`). |

Nothing real leaves the machine: the only payload that ever transits otari.ai
and the tunnel is the fake `.env`.
