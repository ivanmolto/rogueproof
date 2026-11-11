// Server-only: loads a golden run through the orchestrator's replay (run.json +
// log.txt, no model call, no network, no key). The dashboard never calls Otari;
// it asks the orchestrator.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunRecord, Timeline } from "@rogueproof/shared";
import type { ReplayView, RunKey } from "./view";

/**
 * The built orchestrator (packages/orchestrator/dist), loaded by Node at run
 * time and kept out of Next's bundle: its replay reads the shared JSON Schemas
 * from disk next to the package, which a bundled copy cannot find.
 */
const orchestrator = (): Promise<typeof import("@rogueproof/orchestrator")> => import(/* webpackIgnore: true */ "@rogueproof/orchestrator");

/** runs/golden of the repo: GOLDEN_RUNS_DIR, or found from the working directory (repo root or apps/dashboard). */
export function goldenDir(cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.GOLDEN_RUNS_DIR) return resolve(env.GOLDEN_RUNS_DIR);
  const here = resolve(cwd, "runs", "golden");
  return existsSync(here) ? here : resolve(cwd, "..", "..", "runs", "golden");
}

/** The page's view of one replayed run. Pure. */
export function toView(key: RunKey, record: RunRecord, timeline: Timeline, problems: readonly string[]): ReplayView {
  const c = record.collector;
  return {
    run: key,
    runId: record.runId,
    mode: record.mode,
    profile: record.profile,
    outcome: record.outcome,
    // Replay puts an end user on events only when the run's key named one.
    endUser: timeline.events.find((e) => e.endUser !== undefined)?.endUser ?? null,
    runLabel: record.endUser,
    agentModel: record.models.agent,
    costUsd: record.usage?.costUsd ?? null,
    endUserSpendUsd: record.usage?.endUserSpendUsd ?? null,
    collector: c ? { drops: c.drops, crossCheck: c.crossCheck ?? null, fakeSecrets: [...(c.fakeSecrets ?? [])] } : null,
    guardrailBlockedRequestIds: (record.calls ?? []).flatMap((call) => (call.outcome === "guardrail_blocked" && call.requestId !== undefined ? [call.requestId] : [])),
    events: timeline.events,
    problems: [...problems],
  };
}

/** Replays runs/golden/<key>. Throws the orchestrator's ReplayError when the run cannot be read or is invalid. */
export async function loadReplay(key: RunKey, dir: string = goldenDir()): Promise<ReplayView> {
  const { run } = await orchestrator();
  const r = run.replayDir(join(dir, key));
  return toView(key, r.record, r.timeline, r.problems);
}
