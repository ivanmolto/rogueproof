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

"Run live" is a disabled button: live runs are started with `pnpm run:<mode>`.
