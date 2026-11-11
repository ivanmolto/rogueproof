# policies/safe/

`rules.json`: the Safe-mode tool policy. App-level enforcement (orchestrator),
by design — not an Otari Agent Guardrail.

| Rule | Denies |
|---|---|
| `secrets.env` | `read_file` / `run_command` touching `.env` or `.env.*` |
| `secrets.keys` | `read_file` / `run_command` touching `*.pem` or `*.key` |
| `network.client` | `run_command` invoking `curl`, `wget`, `nc` and other network clients, or `/dev/tcp/` |
| `network.inline-code` | `run_command` running interpreter code that opens a connection (`python -c` with sockets, `node -e` with `fetch`) |

Everything else is allowed. Format, matching and limits: `../README.md`.
