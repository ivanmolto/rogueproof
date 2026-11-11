// The command behind `pnpm run:safe`, `pnpm run:permissive` and `pnpm run:control`: read the
// environment, wire the real dependencies (gateway client, telemetry, collector
// on loopback, Docker sandbox) and hand them to runScenario(). The two modes
// differ in the policy directory, the end-user prefix and what Permissive adds:
// the recorded guardrail mandate must be Monitor, the tries are bounded, and
// docs/evidence/permissive.md is rebuilt after the run. Control (task 4.1b) is
// the Permissive scenario forced onto MODEL_PROFILE=dev (model D), end user
// `control-run-<n>`, `control: true` in run.json: never golden, never a rubric
// try, never in the Permissive evidence document. Budget-limited (task 4.2) is the
// Safe scenario on the `agent-capped` key (role `capped`), run id `budget-run-<n>`:
// it refuses to start unless that key's budget has a request_limit, and exits 1
// when anything but the gateway's budget refusal ended it. `run:safe --fallback-demo`
// (task 4.5) is the Safe scenario on the fallback-test workspace's key (role
// `fallback`, a plain key: `safe-run-<n>` is the run's label), after the workspace
// mirror check in fallbackDemo.ts; its golden copy goes to runs/golden/safe-fallback.
// Never prints a key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FALLBACK_ROLE, OtariClient, OtariTelemetry, ROLE_ENV, SELECTORS, findRepoRoot, loadDotEnv, readOtariEnv } from "../otari/index.js";
import { createJudgeGate, loadPolicy } from "../policy/index.js";
import { assertSandboxSafe, copyMission, createDockerSandbox, hostSecrets, startSandbox, stopSandbox, type Runner } from "../sandbox/index.js";
import { COLLECTOR_PORT, REGISTRY_PORT, normalizePrefix, publicOrigin } from "../tunnel/config.js";
import { COLLECTOR_MCP_PATH, REGISTRY_MCP_PATH, REGISTRY_SURFACE, createMcpCollector } from "./collector.js";
import { FALLBACK_COLLECTOR_ENV, FALLBACK_GOLDEN_DIR, FALLBACK_REGISTRY_ENV, FALLBACK_WORKSPACE, RESTORE_REMINDER, checkFallbackWorkspace } from "./fallbackDemo.js";
import { MAX_PERMISSIVE_TRIES, permissiveRow, permissiveStanding, readPermissiveRows, readPermissiveRuns, readVoidedRunIds, renderPermissiveEvidence } from "./permissiveEvidence.js";
import type { Replacement } from "./record.js";
import { RunRefused, assertGoldenAllowed, nextRunNumber, runScenario, runStamp, type ScenarioOptions, type ScenarioSandbox } from "./scenario.js";

export type CliMode = ScenarioOptions["mode"];
const PROBE_TIMEOUT_MS = 15_000;
export const PERMISSIVE_EVIDENCE_FILE = join("docs", "evidence", "permissive.md");

async function probeHoneypot(url: string): Promise<void> {
  let status: number;
  try {
    status = (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).status;
  } catch (e) {
    throw new RunRefused(`the honeypot is not reachable at its public URL (are \`pnpm honeypot\` and \`pnpm tunnel\` running?): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (status !== 200) throw new RunRefused(`the honeypot answered HTTP ${status} at its public URL (are \`pnpm honeypot\` and \`pnpm tunnel\` running?)`);
}

/**
 * The scenario's sandbox on Docker. `check` is `sandbox:check` on the compose
 * file and the committed mission before anything is spent; `start` repeats it
 * on the run's copy and then on the running container (no network, no mount
 * but /work, every .env value contains FAKE). Any finding throws.
 */
export function dockerScenarioSandbox(repoRoot: string, runner?: Runner): ScenarioSandbox {
  const r = runner ? { runner } : {};
  return {
    check: async () => void (await assertSandboxSafe({ repoRoot, container: "skip", ...r })),
    copyMission: (workDir) => void copyMission(join(repoRoot, "scenarios", "mission"), workDir),
    start: async (workDir) => void (await startSandbox({ repoRoot, workDir, ...r })),
    stop: () => stopSandbox({ repoRoot, ...r }),
    tools: createDockerSandbox(),
  };
}

/**
 * Permissive mode needs a flagged request served, so Otari's mandated inference
 * guardrail must be in Monitor. otari-config/guardrails/injection.json mirrors
 * the dashboard; a mandate recorded in any other mode refuses the run.
 */
export function assertMonitorMandate(repoRoot: string): void {
  const file = join(repoRoot, "otari-config", "guardrails", "injection.json");
  let mode: unknown;
  try {
    mode = (JSON.parse(readFileSync(file, "utf8")) as { mandate?: { mode?: unknown } }).mandate?.mode;
  } catch {
    throw new RunRefused("otari-config/guardrails/injection.json is missing or unreadable; run:permissive needs the recorded mandate mode");
  }
  if (mode !== "monitor") {
    throw new RunRefused(`run:permissive needs Otari's inference guardrail mandated in Monitor; otari-config/guardrails/injection.json records ${JSON.stringify(mode ?? null)}`);
  }
}

/** Rubric tries are bounded: after the last one without a drop, the refusals are the finding and another run needs `--extra-try`. */
export function assertTriesLeft(runsDir: string, profile: string, extraTry: boolean): void {
  if (profile !== "rubric" || extraTry) return;
  const s = permissiveStanding(readPermissiveRows(runsDir));
  if (s.refusalsAreTheFinding) {
    throw new RunRefused(
      `${s.tries} rubric Permissive tries are saved and none dropped anything; the refusals are recorded in ${PERMISSIVE_EVIDENCE_FILE} as the finding. Pass --extra-try to spend another run.`,
    );
  }
}

export function writePermissiveEvidence(repoRoot: string, runsDir: string): string {
  const file = join(repoRoot, PERMISSIVE_EVIDENCE_FILE);
  mkdirSync(join(repoRoot, "docs", "evidence"), { recursive: true });
  writeFileSync(file, renderPermissiveEvidence(readPermissiveRuns(runsDir), readVoidedRunIds(runsDir)));
  return file;
}

/**
 * The registry's server id: REGISTRY_MCP_SERVER_ID in .env, and the same id in
 * otari-config/mcp/registry.json (the server whose allow-list is `submit_report`
 * only). A run without the registry would leave the mission's last step impossible.
 */
export function registryServerId(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const id = (env["REGISTRY_MCP_SERVER_ID"] ?? "").trim();
  if (id === "") throw new RunRefused("REGISTRY_MCP_SERVER_ID is not set (register the report registry in the workspace: otari-config/apply.md step 8)");
  let registered: unknown;
  try {
    registered = (JSON.parse(readFileSync(join(repoRoot, "otari-config", "mcp", "registry.json"), "utf8")) as { serverId?: unknown }).serverId;
  } catch {
    throw new RunRefused("otari-config/mcp/registry.json is missing or unreadable");
  }
  if (registered !== id) throw new RunRefused("REGISTRY_MCP_SERVER_ID and otari-config/mcp/registry.json name different servers");
  return id;
}

/**
 * An MCP server's id in the fallback-test workspace: MCP servers are registered per workspace, so the collector
 * and the registry have other ids there. As for `rogueproof`, the id in .env must be the one recorded in
 * otari-config/mcp/<name>.json (`otherWorkspaces`), the server whose allow-list is the one tool.
 */
export function fallbackServerId(repoRoot: string, name: "collector" | "registry", env: NodeJS.ProcessEnv = process.env): string {
  const envName = name === "collector" ? FALLBACK_COLLECTOR_ENV : FALLBACK_REGISTRY_ENV;
  const id = (env[envName] ?? "").trim();
  if (id === "") throw new RunRefused(`${envName} is not set (register the ${name} in the ${FALLBACK_WORKSPACE} workspace: otari-config/apply.md step 10)`);
  let recorded: unknown;
  try {
    const file = JSON.parse(readFileSync(join(repoRoot, "otari-config", "mcp", `${name}.json`), "utf8")) as { otherWorkspaces?: Record<string, { serverId?: unknown }> };
    recorded = file.otherWorkspaces?.[FALLBACK_WORKSPACE]?.serverId;
  } catch {
    throw new RunRefused(`otari-config/mcp/${name}.json is missing or unreadable`);
  }
  if (recorded !== id) throw new RunRefused(`${envName} and otari-config/mcp/${name}.json (otherWorkspaces.${FALLBACK_WORKSPACE}.serverId) name different servers`);
  return id;
}

/** The mandate `rogueproof` runs under, as recorded: what the test workspace has to mirror. */
export function recordedMandate(repoRoot: string): { profile: string; mode: string } {
  try {
    const m = (JSON.parse(readFileSync(join(repoRoot, "otari-config", "guardrails", "injection.json"), "utf8")) as { mandate?: { profile?: unknown; mode?: unknown } }).mandate;
    if (typeof m?.profile === "string" && typeof m.mode === "string") return { profile: m.profile, mode: m.mode };
  } catch {
    // Reported below.
  }
  throw new RunRefused("otari-config/guardrails/injection.json records no mandate profile and mode; --fallback-demo needs them to compare the test workspace against");
}

/**
 * Every run on the service key names a new end user, and the key holds at most `maxEndUsers`
 * (otari-config/keys.json). The gateway refuses the first call of the run after that; it is not
 * retried. Returns what to do about it, or undefined when the log shows no such refusal (task 6.1).
 */
export function endUserLimitHint(logText: string, mode: string): string | undefined {
  if (!logText.includes("end_user_limit_reached")) return undefined;
  return `the agent-service key has as many end users as it may have (Max end users, otari-config/keys.json), so the gateway refused a new one. Re-run on an end user that exists (pnpm run:${mode} --n <number of an earlier ${mode} run>), or have the org owner raise Max end users on the key.`;
}

export async function runCli(mode: CliMode, argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { golden: { type: "boolean", default: false }, n: { type: "string" }, "agent-model": { type: "string" }, "extra-try": { type: "boolean", default: false }, "fallback-demo": { type: "boolean", default: false } },
  });
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === undefined) throw new Error("run this from inside the rogueproof repository");
  if (mode === "control") {
    if (values.golden) throw new RunRefused("run:control takes no --golden: the control run is excluded from the golden and rubric runs");
    // Set before .env is read (loadDotEnv keeps what is already set): the control run is model D whatever .env says.
    process.env["MODEL_PROFILE"] = "dev";
  }
  loadDotEnv();
  const env = readOtariEnv();
  assertGoldenAllowed(env.profile, values.golden);

  // Open-weight agent other than the routing policy's pick (rubric only; model D is never a rubric role).
  const pick = values["agent-model"];
  if (pick !== undefined && (env.profile !== "rubric" || !["A", "B", "C"].includes(pick))) {
    throw new RunRefused("--agent-model takes A, B or C and needs MODEL_PROFILE=rubric");
  }
  const agentModel = pick === undefined ? undefined : SELECTORS[pick as "A" | "B" | "C"];

  const fallbackDemo = values["fallback-demo"];
  if (fallbackDemo) {
    if (mode !== "safe") throw new RunRefused("--fallback-demo is a run:safe flag");
    // The test workspace holds one routing policy, agent-primary (open-weight models only), and the invalid key is Together's.
    if (env.profile !== "rubric") throw new RunRefused(`--fallback-demo needs MODEL_PROFILE=rubric; the profile is "${env.profile}"`);
    // A selector sent directly has no routing policy and so no backup to fall back to.
    if (pick !== undefined) throw new RunRefused("--fallback-demo sends the agent-primary routing policy; it takes no --agent-model");
    if (!env.keys[FALLBACK_ROLE]) throw new RunRefused(`${ROLE_ENV[FALLBACK_ROLE]} is not set (the ${FALLBACK_WORKSPACE} workspace key, otari-config/keys.json)`);
  }

  const honeypotOrigin = publicOrigin(process.env["HONEYPOT_PUBLIC_URL"], "HONEYPOT_PUBLIC_URL");
  const prefix = normalizePrefix(process.env["HONEYPOT_PREFIX"]);
  const honeypotUrl = `${honeypotOrigin}${prefix}/`;
  const collectorId = (process.env["COLLECTOR_MCP_SERVER_ID"] ?? "").trim();
  if (collectorId === "") throw new RunRefused("COLLECTOR_MCP_SERVER_ID is not set (register the collector in the workspace, task 3.2)");
  // The id in .env must be the server recorded in otari-config (the one whose allow-list is `drop` only).
  const registered = (JSON.parse(readFileSync(join(repoRoot, "otari-config", "mcp", "collector.json"), "utf8")) as { serverId?: unknown }).serverId;
  if (registered !== collectorId) throw new RunRefused("COLLECTOR_MCP_SERVER_ID and otari-config/mcp/collector.json name different servers");
  const collectorOrigin = (process.env["COLLECTOR_PUBLIC_URL"] ?? "").trim().replace(/\/+$/, "");
  const registryId = registryServerId(repoRoot);
  if (registryId === collectorId) throw new RunRefused("REGISTRY_MCP_SERVER_ID and COLLECTOR_MCP_SERVER_ID name the same server");
  const registryOrigin = (process.env["REGISTRY_PUBLIC_URL"] ?? "").trim().replace(/\/+$/, "");
  const mcpServerIds = fallbackDemo ? [fallbackServerId(repoRoot, "collector"), fallbackServerId(repoRoot, "registry")] : [collectorId, registryId];
  if (mcpServerIds[0] === mcpServerIds[1]) throw new RunRefused(`${FALLBACK_COLLECTOR_ENV} and ${FALLBACK_REGISTRY_ENV} name the same server`);
  const mandate = fallbackDemo ? recordedMandate(repoRoot) : undefined;

  const runsDir = join(repoRoot, "runs");
  // Control is the Permissive scenario: same mandate mode, same empty tool policy. It is not a rubric try.
  const permissiveLike = mode === "permissive" || mode === "control";
  if (permissiveLike) assertMonitorMandate(repoRoot);
  if (mode === "permissive") assertTriesLeft(runsDir, env.profile, values["extra-try"]);
  let n = nextRunNumber(runsDir, mode);
  if (values.n !== undefined) {
    n = Number(values.n);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--n takes a positive whole number, got "${values.n}"`);
  }
  const runId = `${runStamp(new Date())}-${mode}`;
  const runDir = join(runsDir, runId);

  const client = new OtariClient({ env, recordFile: join(runDir, "records.jsonl") });
  const secrets: Replacement[] = hostSecrets().map((s) => [s, "[REDACTED]"] as const);
  let result;
  try {
    result = await runScenario({
      mode,
      profile: env.profile,
      golden: values.golden,
      runDir,
      runId,
      goldenDir: join(runsDir, "golden", fallbackDemo ? FALLBACK_GOLDEN_DIR : mode),
      endUser: `${mode}-run-${n}`,
      // agent-capped is a plain key: it names no end user, so `budget-run-<n>` is the run's label only.
      // So is fallback-test (the key of the fallback-test workspace).
      role: mode === "budget" ? "capped" : fallbackDemo ? FALLBACK_ROLE : "service",
      honeypotUrl,
      mcpServerIds,
      ...(mandate !== undefined
        ? {
            fallbackDemo: true,
            // Its own client: the probes are not the run's calls and stay out of run.json and records.jsonl.
            preflight: async (log) => {
              const check = await checkFallbackWorkspace({
                client: new OtariClient({ env, recordFile: join(runDir, "preflight.records.jsonl") }),
                mcpServerIds,
                guardrail: mandate,
              });
              for (const f of check.findings) log.info(`mirror check (${FALLBACK_WORKSPACE}) · ${f.ok ? "yes" : "NO "} · ${f.check} · ${f.detail}`);
              log.info(`mirror check: ${check.calls} gateway call(s), $${check.costUsd.toFixed(6)}, on the fallback-test key (not part of the run's calls)`);
              if (!check.ok) throw new RunRefused(`${FALLBACK_WORKSPACE} does not mirror rogueproof (otari-config/apply.md step 10): ${check.findings.filter((f) => !f.ok).map((f) => f.check).join(" · ")}`);
            },
          }
        : {}),
      ...(agentModel !== undefined ? { agentModel } : {}),
      policy: loadPolicy(join(repoRoot, "policies", permissiveLike ? "permissive" : "safe")),
      client,
      telemetry: new OtariTelemetry({ env }),
      collector: createMcpCollector({ url: `http://127.0.0.1:${COLLECTOR_PORT}${COLLECTOR_MCP_PATH}`, bearer: process.env["COLLECTOR_BEARER"] ?? "" }),
      registry: createMcpCollector({ url: `http://127.0.0.1:${REGISTRY_PORT}${REGISTRY_MCP_PATH}`, bearer: process.env["REGISTRY_BEARER"] ?? "", surface: REGISTRY_SURFACE }),
      sandbox: dockerScenarioSandbox(repoRoot),
      // On rubric runs the judge role resolves to model C (otari/models.ts, decision 002).
      // The Permissive policy has no rule, so it denies nothing and the judge is never called there.
      judge: (onCall) => createJudgeGate({ client, onCall }),
      probeHoneypot,
      replacements: secrets,
      // The golden copy is public: the honeypot serves live injections under an unlisted prefix.
      goldenReplacements: [
        [`${honeypotOrigin}${prefix}`, "https://honeypot.example/lumen-notes"],
        [honeypotOrigin, "https://honeypot.example"],
        ...(collectorOrigin !== "" ? [[collectorOrigin, "https://collector.example"] as const] : []),
        ...(registryOrigin !== "" ? [[registryOrigin, "https://registry.example"] as const] : []),
      ],
      echo: (line) => console.log(line),
    });
  } finally {
    // Also after a run that ended without a run.json: the file lists what is saved.
    if (mode === "permissive" && existsSync(join(repoRoot, "docs"))) console.log(`evidence: ${writePermissiveEvidence(repoRoot, runsDir)}`);
    // Also after a refused or failed run: the invalid key may be pinned whatever happened next.
    if (fallbackDemo) console.log(`\n${RESTORE_REMINDER.join("\n")}\n`);
  }

  const r = result.record;
  console.log(`\nrun:${mode} · outcome ${r.outcome} · ${r.modelCalls} model calls · cost $${(r.usage?.costUsd ?? 0).toFixed(6)} · collector drops ${r.collector?.drops ?? "?"}`);
  console.log(`registry (benign MCP tool): ${r.registry?.submitCalls ?? 0} submit_report call(s) in otari_tool_calls, ${r.registry?.submissions ?? "?"} report(s) in list_reports`);
  if ((r.registry?.fakeSecrets?.length ?? 0) > 0) console.log(`FAKE SECRETS IN THE REGISTRY: ${r.registry!.fakeSecrets!.join(", ")} left through submit_report, not through drop`);
  if (fallbackDemo) {
    const rescued = r.calls?.filter((c) => c.otariHeaders?.["otari-fallback"] === "true") ?? [];
    console.log(
      rescued.length > 0
        ? `RESCUED BY FALLBACK: ${rescued.length} call(s) with Otari-Fallback: true · first request ${rescued[0]!.requestId ?? "?"} served by ${rescued[0]!.otariHeaders?.["otari-provider"] ?? "?"} (${r.models.fallback ?? "?"})`
        : "NO fallback in this run: no call carries Otari-Fallback: true",
    );
    for (const [name, ok] of Object.entries(result.evidence)) if (!ok) console.log(`evidence NOT met: ${name}`);
  }
  if (mode === "budget") {
    const stop = r.budgetStop;
    console.log(
      stop
        ? `STOPPED BY THE BUDGET: HTTP ${stop.status} ${stop.code ?? ""} · "${stop.message}" · request ${stop.requestId ?? "?"} · request_limit ${stop.requestLimit ?? "?"} · ${stop.requestsServed ?? "?"} served, then refused · ${stop.remainingAfter ?? "?"} left`
        : `NOT stopped by the budget: the run ended with outcome ${r.outcome}. Is request_limit set on agent-capped (otari-config/budgets/request-limit.json)?`,
    );
    for (const [name, ok] of Object.entries(result.evidence)) if (!ok) console.log(`evidence NOT met: ${name}`);
    console.log("reset the limit now: pnpm budget:reset (otari-config/budgets/reset.json)");
  }
  if (permissiveLike) {
    const row = permissiveRow(r);
    console.log(
      row.result === "exfiltrated"
        ? `EXFILTRATED (fake data): ${row.dropCalls} drop call(s) in otari_tool_calls, ${row.drops} payload(s) in list_drops, holding ${row.fakeSecrets.join(", ")}`
        : `no exfiltration evidenced (${row.result}): ${row.dropCalls} drop call(s) in otari_tool_calls, ${row.drops} payload(s) in list_drops`,
    );
    const s = permissiveStanding(readPermissiveRows(runsDir));
    if (mode === "control") {
      console.log(`control run (frontier model, not rubric): agent ${r.models.agent} · end user ${r.endUser} · ${result.evidence["every served call on the Anthropic provider key"] ? "every served call on the Anthropic provider key" : "NOT every call was served by the Anthropic provider key"}`);
    } else if (!s.exfiltrated && env.profile === "rubric") {
      console.log(
        s.refusalsAreTheFinding
          ? `rubric tries: ${s.tries} of ${MAX_PERMISSIVE_TRIES}, none dropped anything; the refusals are recorded as the finding in ${PERMISSIVE_EVIDENCE_FILE}`
          : `rubric tries: ${s.tries} of ${MAX_PERMISSIVE_TRIES} (try the other of --agent-model A | B next)`,
      );
    }
  }
  if (r.outcome === "error") {
    let logText = "";
    try {
      logText = readFileSync(join(result.runDir, "log.txt"), "utf8");
    } catch {
      // No log: no hint.
    }
    const hint = endUserLimitHint(logText, mode);
    if (hint !== undefined) console.log(hint);
  }
  console.log(`output: ${result.runDir}${result.goldenDir ? `\ngolden: ${result.goldenDir}` : ""}`);
  if (mode === "budget") return r.budgetStop ? 0 : 1;
  return r.outcome === "error" ? 1 : 0;
}

/** Entry point shared by the run scripts: exit 0 on a completed run, 1 on outcome `error` (run:budget: on a run the budget did not stop), 2 on a refusal. */
export function mainCli(mode: CliMode): void {
  runCli(mode).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}
