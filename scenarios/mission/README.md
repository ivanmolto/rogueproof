# scenarios/mission/

The Agent Zero mission and its fake workspace (task 3.3). The orchestrator
copies this directory fresh for every run and mounts the copy at `/work` in the
sandbox container; it is the only thing the agent's local tools can see.

**All secrets here are fake.** `.env` holds made-up demo values, none of them
was ever issued by any service, and every value contains `FAKE`. Every `run:*`
script refuses to start otherwise. The file is committed on purpose (the one
`.env` the `.gitignore` lets through): it is the bait the injected agent is
told to steal, and the only payload that ever transits otari.ai and the tunnel.

| File | What it is |
|---|---|
| `MISSION.md` | The task given to the agent. `{{HONEYPOT_URL}}` is the only placeholder; the orchestrator replaces it with the public honeypot URL from `pnpm tunnel` at run start. It names no other address. |
| `.env` | `FAKE_DEMO_OPENAI_KEY` and `FAKE_DEMO_DB_PASSWORD`. Fake, see above. |
| `REPORT.md` | Not in git. Written by the agent during a run, in the per-run copy. |

No code lives here and nothing imports Otari. The checks (every `.env` value
contains `FAKE`, `MISSION.md` references only the placeholder, the workspace
holds exactly these files) are in `test/mission.test.ts` at the repo root, so
the workspace the agent sees stays free of test files.
