// `pnpm policy:check`: every policy under policies/ against the 10-call fixture
// (5 malicious, 5 benign). Safe must deny each malicious call with the rule the
// fixture names and allow each benign one; Permissive must allow all ten.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLocalToolCall } from "../agent/tools.js";
import type { LocalToolCall } from "../agent/types.js";
import { loadPolicy } from "./rules.js";

export const FIXTURE_FILE = join("fixtures", "ten-calls.json");
export const POLICY_MODES = ["safe", "permissive"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export interface FixtureCall {
  id: string;
  label: "malicious" | "benign";
  call: LocalToolCall;
  /** The rule Safe must deny a malicious call with. */
  safeRule?: string;
}

export interface CheckRow {
  policy: PolicyMode;
  id: string;
  label: FixtureCall["label"];
  expected: string;
  actual: string;
  pass: boolean;
}

export interface PolicyCheckResult {
  ok: boolean;
  rows: CheckRow[];
  /** Problems with the fixture itself (wrong count, bad shape). */
  problems: string[];
}

/** Read and validate the fixture. Throws on a shape error; a wrong 5/5 split is reported by checkPolicies. */
export function loadFixtureCalls(policiesDir: string): FixtureCall[] {
  const file = join(policiesDir, FIXTURE_FILE);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { calls?: unknown };
  if (!Array.isArray(raw.calls)) throw new Error(`${file}: "calls" must be an array`);
  return raw.calls.map((c, i) => {
    const o = (typeof c === "object" && c !== null ? c : {}) as Record<string, unknown>;
    const where = `${file}: calls[${i}]`;
    if (typeof o["id"] !== "string" || typeof o["tool"] !== "string") throw new Error(`${where} needs string "id" and "tool"`);
    if (o["label"] !== "malicious" && o["label"] !== "benign") throw new Error(`${where} needs label "malicious" or "benign"`);
    // Parsed exactly as a model's tool call is.
    const parsed = parseLocalToolCall(o["tool"], JSON.stringify(o["args"] ?? null));
    if (!parsed.ok) throw new Error(`${where}: ${parsed.error}`);
    const out: FixtureCall = { id: o["id"], label: o["label"], call: parsed.call };
    if (o["label"] === "malicious") {
      if (typeof o["safeRule"] !== "string") throw new Error(`${where}: a malicious call names its "safeRule"`);
      out.safeRule = o["safeRule"];
    }
    return out;
  });
}

export function checkPolicies(policiesDir: string): PolicyCheckResult {
  const calls = loadFixtureCalls(policiesDir);
  const problems: string[] = [];
  const count = (l: FixtureCall["label"]): number => calls.filter((c) => c.label === l).length;
  if (count("malicious") !== 5 || count("benign") !== 5) {
    problems.push(`the fixture must hold 5 malicious and 5 benign calls; found ${count("malicious")} and ${count("benign")}`);
  }
  if (new Set(calls.map((c) => c.id)).size !== calls.length) problems.push("fixture call ids must be unique");

  const rows: CheckRow[] = [];
  for (const mode of POLICY_MODES) {
    const policy = loadPolicy(join(policiesDir, mode));
    if (policy.name !== mode) problems.push(`policies/${mode}/rules.json names itself "${policy.name}"`);
    for (const c of calls) {
      const v = policy.evaluate(c.call);
      const expected = mode === "safe" && c.label === "malicious" ? `deny (${c.safeRule})` : "allow";
      const actual = v.decision === "deny" ? `deny (${v.rule})` : "allow";
      rows.push({ policy: mode, id: c.id, label: c.label, expected, actual, pass: expected === actual });
    }
  }
  return { ok: problems.length === 0 && rows.every((r) => r.pass), rows, problems };
}
