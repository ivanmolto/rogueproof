// pnpm report [--control <runDir>]
//
// The Trust Report (task 4.4): one model call on the `report` key with
// `otari_code_execution` and no other tool. The three golden runs
// (runs/golden/safe, permissive, budget) and the control run (the latest
// runs/*-control, or --control; a labelled column, never rubric evidence) are
// summarised, a Python program computes blocks, guardrail hits, spend,
// fallbacks, open-weight models and time to completion in Otari's code
// sandbox, and the numbers are read from the code-execution entry's stdout in
// `otari_tool_calls`. They are checked against the local TypeScript
// computation; a difference writes nothing.
//
// Needs MODEL_PROFILE=rubric (the report role is model B, with C as fallback).
// Output: runs/trust-report.json, runs/trust-report.md and the redacted
// request/response pair in runs/trust-report.records.jsonl.
// Exit 0: generated and verified. 1: the call failed, ran no code or the
// numbers differ. 2: refused before anything was spent. Never prints a key.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { RunRecord } from "@rogueproof/shared";
import { OtariClient, OtariTelemetry, findRepoRoot, loadDotEnv, readOtariEnv } from "./otari/index.js";
import { validateRunRecord } from "./run/record.js";
import { RunRefused } from "./run/scenario.js";
import { RUBRIC_MODES, assertReportRuns, generateTrustReport, renderTrustReport, validateTrustReport } from "./run/trustReport.js";

const USAGE_TRIES = 4;
const USAGE_WAIT_MS = 3000;

function readRun(dir: string): RunRecord {
  const file = join(dir, "run.json");
  if (!existsSync(file)) throw new RunRefused(`${file} does not exist`);
  const rec = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  const violations = validateRunRecord(rec);
  if (violations.length > 0) throw new RunRefused(`${file} does not match shared/run.schema.json: ${violations[0]}`);
  return rec;
}

/** The latest saved control run; run ids start with a timestamp, so the last name is the newest. */
function latestControlDir(runsDir: string): string | undefined {
  if (!existsSync(runsDir)) return undefined;
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith("-control") && existsSync(join(runsDir, e.name, "run.json")))
    .map((e) => join(runsDir, e.name))
    .sort()
    .at(-1);
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { control: { type: "string" } } });
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) throw new Error("run this from inside the rogueproof repository");
  loadDotEnv();
  const env = readOtariEnv();
  if (env.profile !== "rubric") {
    throw new RunRefused(`pnpm report needs MODEL_PROFILE=rubric (the report role is open-weight model B); the profile is "${env.profile}"`);
  }

  const runsDir = join(repoRoot, "runs");
  const controlDir = values.control ?? latestControlDir(runsDir);
  if (controlDir === undefined) throw new RunRefused("no control run is saved under runs/ (pnpm run:control), and no --control <runDir> was given");
  const control = readRun(controlDir);
  if (!control.control) throw new RunRefused(`${controlDir} is not a control run (control:true)`);
  const runs = [...RUBRIC_MODES.map((m) => readRun(join(runsDir, "golden", m))), control];
  assertReportRuns(runs);

  console.log(`report · ${runs.map((r) => `${r.control ? "control" : r.mode}: ${r.runId} (${r.endUser})`).join(" · ")}`);
  console.log("one model call on the report key, otari_code_execution only (about $0.01 to $0.02 of otari.ai credit)");

  const client = new OtariClient({ env, recordFile: join(runsDir, "trust-report.records.jsonl") });
  const result = await generateTrustReport({ client, runs });
  const call = result.call;
  console.log(
    `report call · outcome ${call.outcome} · request ${call.requestId ?? "?"} · ${call.headers["otari-model"] ?? "?"} on ${call.headers["otari-provider"] ?? "?"}` +
      ` · ${call.otariToolCalls.length} otari_tool_calls · cost $${(call.cost ?? 0).toFixed(6)} · ${call.latencyMs} ms`,
  );
  if (!result.ok) {
    console.error(`NOT generated (${result.failure}): ${result.detail}`);
    for (const line of result.diff) console.error(`  ${line}`);
    console.error("nothing was written; the request/response pair is in runs/trust-report.records.jsonl");
    return 1;
  }

  const violations = validateTrustReport(result.report);
  if (violations.length > 0) {
    console.error(`NOT generated: the report does not match shared/trust-report.schema.json:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
    return 1;
  }

  // The same call in Otari's Usage, by its request id (settlement can lag the response by a few seconds).
  let usage = "not looked up (the response carried no request id)";
  if (call.requestId !== undefined) {
    const telemetry = new OtariTelemetry({ env });
    for (let i = 0; i < USAGE_TRIES; i++) {
      const u = await telemetry.getRequestUsage("report", call.requestId);
      usage = u.available
        ? `request ${u.requestId} visible in Usage: ${u.status}, $${u.cost.toFixed(6)}, ${u.totalTokens} tokens`
        : `request ${call.requestId} not visible in Usage yet (${u.reason})`;
      if (u.available) break;
      await new Promise((r) => setTimeout(r, USAGE_WAIT_MS));
    }
  }

  const jsonFile = join(runsDir, "trust-report.json");
  const mdFile = join(runsDir, "trust-report.md");
  const summary = renderTrustReport(result.report, { programUnchanged: result.programUnchanged, usage });
  writeFileSync(jsonFile, JSON.stringify(result.report, null, 2) + "\n");
  writeFileSync(mdFile, summary);
  console.log(`\n${summary}`);
  console.log(`code-execution entry ${result.entry.id} · exit ${result.entry.exit_code} · verified against the local computation`);
  console.log(`output: ${jsonFile}\n        ${mdFile}`);
  return result.report.rubricModelsOnly ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(e instanceof RunRefused ? 2 : 1);
  },
);
