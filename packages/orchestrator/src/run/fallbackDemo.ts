// `run:safe --fallback-demo` (task 4.5, R1 in a run): the Safe scenario on the
// key of the `rogueproof-fallback-test` workspace, where the organization's
// deliberately invalid Together key is set to "Always use this key". The
// workspace's own `agent-primary` policy then rescues every agent call on its
// first backup, and the gateway says so with `Otari-Fallback: true`; the loop
// turns that header into a `fallback` event (agent/loop.ts).
//
// Before the run spends anything, checkFallbackWorkspace() asks the gateway
// whether the test workspace mirrors `rogueproof`. A workspace API key cannot
// read workspace settings, so the check is two small requests on that key and
// what the gateway answers: a research-shaped one (web tools) and an act-shaped
// one (local tools + the two MCP server ids). Never the model's text.
import { toolSetFor } from "../agent/tools.js";
import { FALLBACK_ROLE, GUARDRAILS_HEADER, parseGuardrailVerdicts, type ChatMessage, type ChatResult, type OtariClient } from "../otari/index.js";

export const FALLBACK_WORKSPACE = "rogueproof-fallback-test";
/** Its own golden directory: runs/golden/safe keeps the service-key run whose end user the Trust Report bills (R8). */
export const FALLBACK_GOLDEN_DIR = "safe-fallback";
export const FALLBACK_COLLECTOR_ENV = "FALLBACK_TEST_COLLECTOR_MCP_SERVER_ID";
export const FALLBACK_REGISTRY_ENV = "FALLBACK_TEST_REGISTRY_MCP_SERVER_ID";

/** The pin took a few seconds to apply on 2026-11-10 (otari-config/routing/fallback-test.md): the first call was still served by Together. */
export const PIN_TRIES = 3;
export const PIN_WAIT_MS = 4000;
const PROBE_MAX_TOKENS = 16;
const PROBE: ChatMessage[] = [{ role: "user", content: "Reply with the single word: hello" }];

export const RESTORE_REMINDER: readonly string[] = [
  `RESTORE THE WORKSPACE NOW: Workspaces → ${FALLBACK_WORKSPACE} → Providers → together → "…" on together-invalid → Reset`,
  '(not "Stop always using this key": that leaves the invalid key enabled as one candidate).',
  "Verify with step 4 of otari-config/routing/fallback-test.md: a new call answers Otari-Provider: together, Otari-Attempt-Count: 1.",
];

export interface MirrorFinding {
  check: string;
  ok: boolean;
  detail: string;
}
export interface MirrorCheck {
  ok: boolean;
  findings: MirrorFinding[];
  /** Gateway calls the check made, and what they cost. */
  calls: number;
  costUsd: number;
}
export interface MirrorCheckOptions {
  client: Pick<OtariClient, "chat">;
  /** The collector's and the registry's ids in the test workspace. */
  mcpServerIds: readonly string[];
  /** The mandate recorded for `rogueproof` in otari-config/guardrails/injection.json. */
  guardrail: { profile: string; mode: string };
  sleep?: (ms: number) => Promise<void>;
}

const served = (r: ChatResult): boolean => r.outcome === "ok" || r.outcome === "fallback" || r.outcome === "tool_error";
const refusal = (r: ChatResult): string => `${r.outcome}${r.status !== undefined ? ` (HTTP ${r.status})` : ""}: ${r.error?.detail ?? r.error?.code ?? "no detail"}`;

/**
 * Does the test workspace behave like `rogueproof` for a Safe run? Four findings:
 * the gateway serves a request carrying the web tools, the invalid key is pinned
 * (the call was rescued), the same inference guardrail ran in the same mode, and
 * the gateway serves a request naming both MCP servers. A request the gateway
 * refuses is a failed finding with the gateway's own words; nothing is retried
 * except waiting for the pin to apply.
 */
export async function checkFallbackWorkspace(o: MirrorCheckOptions): Promise<MirrorCheck> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const findings: MirrorFinding[] = [];
  let calls = 0;
  let costUsd = 0;
  const send = async (set: ReturnType<typeof toolSetFor>): Promise<ChatResult> => {
    const r = await o.client.chat(FALLBACK_ROLE, PROBE, {
      tools: set.tools, maxTokens: PROBE_MAX_TOKENS, temperature: 0, ...(set.mcpServerIds ? { mcpServerIds: set.mcpServerIds } : {}),
    });
    calls++;
    costUsd += r.cost ?? 0;
    return r;
  };

  // 1. Research-shaped request: web tools, the pin, the guardrail.
  let research = await send(toolSetFor("research"));
  for (let i = 1; i < PIN_TRIES && served(research) && !research.fallback; i++) {
    await sleep(PIN_WAIT_MS);
    research = await send(toolSetFor("research"));
  }
  findings.push({
    check: "web search allowed: the gateway serves a request carrying otari_web_fetch + otari_web_search",
    ok: served(research),
    detail: served(research) ? `served, request ${research.requestId ?? "?"}` : refusal(research),
  });
  findings.push({
    check: 'invalid provider key pinned ("Always use this key"): the call is rescued',
    ok: research.fallback,
    detail: research.fallback
      ? `Otari-Fallback: true · attempt ${research.headers["otari-attempt-count"] ?? "?"} · served by ${research.headers["otari-provider"] ?? "?"}`
      : served(research)
        ? `Otari-Fallback is not true after ${calls} call(s); served by ${research.headers["otari-provider"] ?? "?"}. Pin together-invalid (otari-config/routing/fallback-test.md step 1)`
        : "no served call to read the header from",
  });
  const verdicts = parseGuardrailVerdicts(research.headers[GUARDRAILS_HEADER]);
  const mine = verdicts.find((v) => v.profile === o.guardrail.profile);
  findings.push({
    check: `inference guardrail mandated: ${o.guardrail.profile} in ${o.guardrail.mode} mode, as in rogueproof`,
    ok: mine !== undefined && mine.mode === o.guardrail.mode,
    detail: mine
      ? `Otari-Guardrails names ${mine.profile}, mode ${mine.mode}`
      : research.outcome === "guardrail_blocked"
        ? `the request was refused by a guardrail (${refusal(research)}); rogueproof's mandate is ${o.guardrail.mode}`
        : `no ${o.guardrail.profile} verdict in Otari-Guardrails (${verdicts.length} verdict(s)). Add ${FALLBACK_WORKSPACE} to the mandate's workspaces`,
  });

  // 2. Act-shaped request: the gateway refuses an MCP server id the workspace does not know (404, never retried).
  const act = await send(toolSetFor("act", o.mcpServerIds));
  findings.push({
    check: "collector and registry MCP servers registered: the gateway serves a request naming both ids",
    ok: served(act),
    detail: served(act) ? `served, request ${act.requestId ?? "?"}` : refusal(act),
  });

  return { ok: findings.every((f) => f.ok), findings, calls, costUsd };
}
