# @rogueproof/dashboard

Next.js App Router + Tailwind. The dashboard **never calls Otari**; it asks the
orchestrator (lint enforces it). Styling stays plain: red is a denied action
and the exfiltration panel, green a rescued fallback and a completed mission.

```
cd apps/dashboard && pnpm dev   # http://localhost:3000 (builds the orchestrator first: the replay API loads packages/orchestrator/dist)
pnpm e2e                        # Playwright, serves on port 3100
```

- `app/api/replay/[run]/route.ts` — `GET /api/replay/<safe|permissive|budget|safe-fallback>`:
  the run's timeline rebuilt by the orchestrator's `replayDir` from
  `runs/golden/<run>/run.json` + `log.txt`. No model call, no network, no key.
  `GOLDEN_RUNS_DIR` overrides the directory.
- `lib/view.ts` — pure: what the cards show after the first *n* events.
- `components/Dashboard.tsx` — Defense Control, the four cards, Attack Arena, the Trust Report link.
- `app/trust-report/page.tsx` — shows `runs/trust-report.md` as `pnpm report` wrote it.

- `app/api/live/[mode]/route.ts` — `POST /api/live/safe`: a live run as
  server-sent events. The orchestrator's `liveRun` starts the same command as
  `pnpm run:safe` in a child process (no flag: never `--golden`), passes on each
  timeline event the run logs, and ends with `end` (the saved run, read back through
  `replayDir`) or `failed` (the reason). It stops the run after 4 minutes or
  when the sandbox container is no longer running (two missed probes in a row), and
  takes the container down after any stop. A browser that
  drops the stream (tab closed, page reloaded) does not stop the run: it finishes and saves under
  `runs/`, and the page cannot re-attach to it. One live run at a time, so "Run live" answers
  "another live run is in progress" until it ends. A request from
  another origin is refused: a live run spends credit. Live is Safe mode only (`LIVE_MODE_KEYS`
  in `lib/view.ts`): a Permissive run spends a bounded rubric try and Budget-limited needs
  `request_limit` set first, so both stay `pnpm run:*` commands and replays here.
- `lib/sse.ts` — pure: the wire format and its decoder. `lib/live.ts` — server-only: the SSE body.

The page shows the profile a live run would start under (`MODEL_PROFILE` from the server's
environment, else the repo's `.env`) next to the button. It is read on each page load and again
from `GET /api/live` whenever the window regains focus, so an edit to `.env` shows without a
reload; a run that just ended sets it to the profile it recorded.

"Run live" needs what `pnpm run:safe` needs: Docker, `pnpm honeypot`, `pnpm collector`,
`pnpm registry`, `pnpm tunnel` and the keys in `.env`; it runs under `MODEL_PROFILE` from
`.env`. When the run is refused, times out, loses its sandbox or ends with outcome
`error`, the page says why and shows **Fall back to replay**, which replays the mode's
golden run. `e2e/live.spec.ts` answers the live route itself: it starts no run.
