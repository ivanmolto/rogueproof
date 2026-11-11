// Server-only: loads a golden run through the orchestrator's replay (run.json +
// log.txt, no model call, no network, no key). The dashboard never calls Otari;
// it asks the orchestrator.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunRecord, Timeline, TrustReport } from "@rogueproof/shared";
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

/** runs/trust-report.json as `pnpm report` wrote it: TRUST_REPORT_FILE, or next to runs/golden. */
export function trustReportFile(cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.TRUST_REPORT_FILE) return resolve(env.TRUST_REPORT_FILE);
  return resolve(goldenDir(cwd, env), "..", "trust-report.json");
}

export type TrustReportLoad = { status: "ok"; report: TrustReport } | { status: "missing" } | { status: "invalid"; problems: string[] };

/** A trust-report.json's text, checked against the shared schema by the orchestrator. Never throws on bad text. */
export async function readTrustReport(text: string): Promise<TrustReportLoad> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: "invalid", problems: ["not JSON"] };
  }
  const { run } = await orchestrator();
  const problems = run.validateTrustReport(value);
  return problems.length === 0 ? { status: "ok", report: value as TrustReport } : { status: "invalid", problems };
}

/** The Trust Report on this machine: read and validated, absent, or not a valid trust-report.json. */
export async function loadTrustReport(file: string = trustReportFile()): Promise<TrustReportLoad> {
  if (!existsSync(file)) return { status: "missing" };
  return readTrustReport(readFileSync(file, "utf8"));
}
