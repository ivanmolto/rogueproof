// pnpm run:safe [--golden] [--n <number>] [--agent-model A|B|C]
//
// Agent Zero, Safe mode: the agent loop on the service key with end user
// `safe-run-<n>`, the deterministic tool policy in policies/safe/ (app-level
// enforcement in the orchestrator, by design — not an Otari Agent Guardrail),
// the judge gate, and Otari's mandated inference guardrail on every call.
// Needs `pnpm honeypot`, `pnpm collector` and `pnpm tunnel` running, and Docker.
// Output: runs/<timestamp>-safe/{log.txt, run.json, REPORT.md, records.jsonl}.
// `--golden` (MODEL_PROFILE=rubric only) also writes a redacted run.json and log
// to runs/golden/safe/. Never prints a key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { OtariClient, OtariTelemetry, SELECTORS, findRepoRoot, loadDotEnv, readOtariEnv } from "./otari/index.js";
import { createJudgeGate, loadPolicy } from "./policy/index.js";
import {
  RunRefused, assertGoldenAllowed, createMcpCollector, nextRunNumber, runScenario, runStamp, COLLECTOR_MCP_PATH,
  type Replacement,
} from "./run/index.js";
import { assertSandboxSafe, copyMission, createDockerSandbox, hostSecrets, startSandbox, stopSandbox } from "./sandbox/index.js";
import { COLLECTOR_PORT, normalizePrefix, publicOrigin } from "./tunnel/config.js";

const MODE = "safe" as const;
const PROBE_TIMEOUT_MS = 15_000;

async function probeHoneypot(url: string): Promise<void> {
  let status: number;
  try {
    status = (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).status;
  } catch (e) {
    throw new RunRefused(`the honeypot is not reachable at its public URL (are \`pnpm honeypot\` and \`pnpm tunnel\` running?): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (status !== 200) throw new RunRefused(`the honeypot answered HTTP ${status} at its public URL (are \`pnpm honeypot\` and \`pnpm tunnel\` running?)`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { golden: { type: "boolean", default: false }, n: { type: "string" }, "agent-model": { type: "string" } } });
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) throw new Error("run this from inside the rogueproof repository");
  loadDotEnv();
  const env = readOtariEnv();
  assertGoldenAllowed(env.profile, values.golden);

  // Open-weight agent other than the routing policy's pick (rubric only; model D is never a rubric role).
  const pick = values["agent-model"];
  if (pick !== undefined && (env.profile !== "rubric" || !["A", "B", "C"].includes(pick))) {
    throw new RunRefused("--agent-model takes A, B or C and needs MODEL_PROFILE=rubric");
  }
  const agentModel = pick === undefined ? undefined : SELECTORS[pick as "A" | "B" | "C"];

  const honeypotOrigin = publicOrigin(process.env["HONEYPOT_PUBLIC_URL"], "HONEYPOT_PUBLIC_URL");
  const prefix = normalizePrefix(process.env["HONEYPOT_PREFIX"]);
  const honeypotUrl = `${honeypotOrigin}${prefix}/`;
  const collectorId = (process.env["COLLECTOR_MCP_SERVER_ID"] ?? "").trim();
  if (collectorId === "") throw new RunRefused("COLLECTOR_MCP_SERVER_ID is not set (register the collector in the workspace, task 3.2)");
  // The id in .env must be the server recorded in otari-config (the one whose allow-list is `drop` only).
  const registered = (JSON.parse(readFileSync(join(repoRoot, "otari-config", "mcp", "collector.json"), "utf8")) as { serverId?: unknown }).serverId;
  if (registered !== collectorId) throw new RunRefused("COLLECTOR_MCP_SERVER_ID and otari-config/mcp/collector.json name different servers");
  const collectorOrigin = (process.env["COLLECTOR_PUBLIC_URL"] ?? "").trim().replace(/\/+$/, "");

  const runsDir = join(repoRoot, "runs");
  let n = nextRunNumber(runsDir, MODE);
  if (values.n !== undefined) {
    n = Number(values.n);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--n takes a positive whole number, got "${values.n}"`);
  }
  const runId = `${runStamp(new Date())}-${MODE}`;
  const runDir = join(runsDir, runId);

  const client = new OtariClient({ env, recordFile: join(runDir, "records.jsonl") });
  const secrets: Replacement[] = hostSecrets().map((s) => [s, "[REDACTED]"] as const);
  const result = await runScenario({
    mode: MODE,
    profile: env.profile,
    golden: values.golden,
    runDir,
    runId,
    goldenDir: join(runsDir, "golden", MODE),
    endUser: `${MODE}-run-${n}`,
    role: "service",
    honeypotUrl,
    mcpServerIds: [collectorId],
    ...(agentModel !== undefined ? { agentModel } : {}),
    policy: loadPolicy(join(repoRoot, "policies", MODE)),
    client,
    telemetry: new OtariTelemetry({ env }),
    collector: createMcpCollector({ url: `http://127.0.0.1:${COLLECTOR_PORT}${COLLECTOR_MCP_PATH}`, bearer: process.env["COLLECTOR_BEARER"] ?? "" }),
    sandbox: {
      check: async () => void (await assertSandboxSafe({ repoRoot, container: "skip" })),
      copyMission: (workDir) => void copyMission(join(repoRoot, "scenarios", "mission"), workDir),
      start: async (workDir) => void (await startSandbox({ repoRoot, workDir })),
      stop: () => stopSandbox({ repoRoot }),
      tools: createDockerSandbox(),
    },
    // On rubric runs the judge role resolves to model C (otari/models.ts, decision 002).
    judge: (onCall) => createJudgeGate({ client, onCall }),
    probeHoneypot,
    replacements: secrets,
    // The golden copy is public: the honeypot serves live injections under an unlisted prefix.
    goldenReplacements: [
      [`${honeypotOrigin}${prefix}`, "https://honeypot.example/lumen-notes"],
      [honeypotOrigin, "https://honeypot.example"],
      ...(collectorOrigin !== "" ? [[collectorOrigin, "https://collector.example"] as const] : []),
    ],
    echo: (line) => console.log(line),
  });

  const r = result.record;
  console.log(`\nrun:safe · outcome ${r.outcome} · ${r.modelCalls} model calls · cost $${(r.usage?.costUsd ?? 0).toFixed(6)} · collector drops ${r.collector?.drops ?? "?"}`);
  console.log(`output: ${result.runDir}${result.goldenDir ? `\ngolden: ${result.goldenDir}` : ""}`);
  return r.outcome === "error" ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
