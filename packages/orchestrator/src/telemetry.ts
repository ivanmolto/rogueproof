// pnpm telemetry: what the hosted gateway says about the last hour. Usage per role
// key, end-user spend, and whether traces and organization usage can be read with a
// workspace key (`available:false` plus the gateway's reason when they cannot).
// Read-only: no model call, no spend. Never prints a key.
//
//   pnpm telemetry [--since 60] [--end-user smoke-user-1] [--request <role>:<Otari-Request-ID>] [--json]
import { parseArgs } from "node:util";
import { OtariTelemetry, ROLES, loadDotEnv, readOtariEnv, redact, type Role, type Telemetry } from "./otari/index.js";

const { values } = parseArgs({
  options: {
    since: { type: "string", default: "60" },
    "end-user": { type: "string", default: "smoke-user-1" },
    request: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const usd = (n: number) => `$${n.toFixed(6)}`;
const unavailable = (r: Telemetry<unknown>) => (r.available ? "" : `available:false · ${r.reason}`);

async function main(): Promise<number> {
  const minutes = Number(values.since);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`--since takes minutes, got "${values.since}"`);
  loadDotEnv();
  const env = readOtariEnv();
  const t = new OtariTelemetry({ env });
  const since = new Date(Date.now() - minutes * 60_000);
  const endUser = values["end-user"];

  const usage = await t.getUsage(since);
  const traces = await t.getTraces(since);
  const organizationUsage = await t.getOrganizationUsage(since);
  const endUserSpend = await t.getEndUserSpend(endUser);
  let request: Telemetry<unknown> | undefined;
  if (values.request !== undefined) {
    const [role, id] = values.request.split(":");
    if (!role || !id || !(ROLES as readonly string[]).includes(role)) throw new Error(`--request takes <role>:<request id>, role one of ${ROLES.join("|")}`);
    request = await t.getRequestUsage(role as Role, id);
  }

  if (values.json) {
    console.log(JSON.stringify(redact({ since: since.toISOString(), usage, traces, organizationUsage, endUserSpend, request }), null, 2));
    return 0;
  }

  console.log(`telemetry · profile=${env.profile} · base=${env.baseURL} · since ${since.toISOString()} (${minutes} min)`);
  if (usage.available) {
    console.log(`usage (per key)     available · ${usage.totals.requests} requests · ${usage.totals.errors} errors · ${usage.totals.totalTokens} tokens · ${usd(usage.totals.cost)}`);
    for (const role of ROLES) {
      const u = usage.byRole[role];
      if (!u) continue;
      const models = u.byModel.map((m) => `${m.key}×${m.requests}`).join(", ") || "-";
      console.log(`  ${role.padEnd(8)} ${String(u.totals.requests).padStart(3)} req  ${usd(u.totals.cost)}  ${models}`);
      if (role === "service") for (const g of u.byUser) console.log(`    user ${(g.label ?? g.key).padEnd(20)} ${String(g.requests).padStart(3)} req  ${usd(g.cost)}`);
    }
  } else {
    console.log(`usage (per key)     ${unavailable(usage)}`);
  }
  console.log(`traces              ${traces.available ? `available · ${traces.traces.length} traces${traces.hasMore ? " (more)" : ""}` : unavailable(traces)}`);
  console.log(`organization usage  ${organizationUsage.available ? `available · ${organizationUsage.totals.requests} requests · ${usd(organizationUsage.totals.cost)}` : unavailable(organizationUsage)}`);
  console.log(
    `end user ${endUser}  ${endUserSpend.available ? `available · spend ${usd(endUserSpend.spend)} · ${endUserSpend.requests} requests · ${endUserSpend.tokens} tokens${endUserSpend.blocked ? " · BLOCKED" : ""}` : unavailable(endUserSpend)}`,
  );
  if (request) console.log(`request ${values.request}  ${request.available ? JSON.stringify(redact(request)) : unavailable(request)}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
