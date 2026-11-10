// pnpm smoke: one "hello" through every role, plus once via the service key with an
// end user. Prints model, latency, usage, cost and every Otari-* header. Never prints
// a key. Records go to runs/smoke/<timestamp>.jsonl (gitignored).
import { join } from "node:path";
import { OtariClient, ROLES, findRepoRoot, loadDotEnv, readOtariEnv, type ChatResult, type Role } from "./otari/index.js";

loadDotEnv();
const env = readOtariEnv();
const root = findRepoRoot(process.cwd()) ?? process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const client = new OtariClient({ env, recordFile: join(root, "runs", "smoke", `${stamp}.jsonl`) });

const SMOKE_END_USER = "smoke-user-1";
const messages = [{ role: "user" as const, content: "Reply with the single word: hello" }];

function line(label: string, r: ChatResult): string {
  const text = r.response?.choices[0]?.message.content?.trim().slice(0, 40) ?? "";
  const headers = Object.entries(r.headers)
    .filter(([k]) => k.startsWith("otari-"))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const cost = r.cost !== undefined ? `$${r.cost.toFixed(6)}` : "cost=n/a";
  const err = r.error ? ` error=${r.error.code ?? "?"}: ${r.error.detail ?? ""}` : "";
  return (
    `${label.padEnd(18)} ${r.outcome.padEnd(16)} ${String(r.status ?? "-").padEnd(4)} ${String(r.latencyMs).padStart(6)}ms  ` +
    `${r.model}  tokens=${r.usage.promptTokens}+${r.usage.completionTokens} ${cost}  "${text}"${err}\n    ${headers}`
  );
}

async function main(): Promise<number> {
  console.log(`smoke · profile=${env.profile} · base=${env.baseURL}`);
  const results: { label: string; r: ChatResult }[] = [];
  for (const role of ROLES) {
    const r = await client.chat(role as Role, messages, { maxTokens: 16 });
    results.push({ label: role, r });
    console.log(line(role, r));
  }
  const svc = await client.chat("service", messages, { maxTokens: 16, endUser: SMOKE_END_USER });
  results.push({ label: `service+${SMOKE_END_USER}`, r: svc });
  console.log(line("service+endUser", svc));

  const okLike = results.filter((x) => x.r.outcome === "ok" || x.r.outcome === "fallback").length;
  const total = results.reduce((s, x) => s + (x.r.cost ?? 0), 0);
  console.log(`\n${okLike}/${results.length} completions ok · total cost $${total.toFixed(6)} · records: runs/smoke/${stamp}.jsonl`);
  return okLike === results.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
