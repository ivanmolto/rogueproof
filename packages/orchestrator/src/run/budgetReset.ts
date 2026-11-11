// `pnpm budget:reset`: the reset of Budget-limited mode's request_limit. The
// PATCH itself needs the org owner's dashboard session or the master key (a
// workspace API key is refused), so this command does not send it: it prints
// the documented request (otari-config/budgets/reset.json) and then reads the
// capped key's own budget (GET /key/budget) to say whether the limit is gone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyBudget, Telemetry } from "../otari/index.js";

export const BUDGET_DOCS = { set: join("otari-config", "budgets", "request-limit.json"), reset: join("otari-config", "budgets", "reset.json") } as const;

/** One documented budget change: where to find the budget's id and what to PATCH. */
export interface BudgetPatchDoc {
  key: string;
  auth: string;
  find: { method: "GET"; path: string };
  apply: { method: "PATCH"; path: string; body: { request_limit: number | null } };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a file under otari-config/budgets/. Throws on anything but the documented shape. */
export function readBudgetPatchDoc(repoRoot: string, file: string): BudgetPatchDoc {
  const raw: unknown = JSON.parse(readFileSync(join(repoRoot, file), "utf8"));
  const find = isObj(raw) ? raw["find"] : undefined;
  const apply = isObj(raw) ? raw["apply"] : undefined;
  const body = isObj(apply) ? apply["body"] : undefined;
  const limit = isObj(body) ? body["request_limit"] : undefined;
  if (
    !isObj(raw) || typeof raw["key"] !== "string" || typeof raw["auth"] !== "string" ||
    !isObj(find) || find["method"] !== "GET" || typeof find["path"] !== "string" ||
    !isObj(apply) || apply["method"] !== "PATCH" || typeof apply["path"] !== "string" ||
    !isObj(body) || Object.keys(body).length !== 1 || !(limit === null || (typeof limit === "number" && Number.isInteger(limit) && limit > 0))
  ) {
    throw new Error(`${file} is not a budget PATCH document (key, auth, find, apply with a request_limit body)`);
  }
  return { key: raw["key"], auth: raw["auth"], find: { method: "GET", path: find["path"] }, apply: { method: "PATCH", path: apply["path"], body: { request_limit: limit } } };
}

export interface ResetReport {
  lines: string[];
  /** 0: no request limit on the key. 1: a limit is still set. 2: the key's budget could not be read. */
  code: 0 | 1 | 2;
}

/** What `pnpm budget:reset` prints and exits with, from the documented PATCH and the key's budget as the gateway reports it. */
export function budgetResetReport(doc: BudgetPatchDoc, budget: Telemetry<KeyBudget>): ResetReport {
  const lines = [
    `Reset request_limit on the budget of key "${doc.key}" (${doc.auth}):`,
    `  1. ${doc.find.method} ${doc.find.path}   -> the id of the budget "${doc.key}" points at`,
    `  2. ${doc.apply.method} ${doc.apply.path}   body ${JSON.stringify(doc.apply.body)}`,
    "",
  ];
  if (!budget.available) {
    lines.push(`NOT VERIFIED: GET /key/budget on "${doc.key}" was not readable (${budget.reason}).`);
    return { lines, code: 2 };
  }
  const limited = budget.limits.find((l) => l.limitRequests !== undefined);
  if (limited) {
    lines.push(`STILL LIMITED: GET /key/budget on "${doc.key}" reads request_limit ${limited.limitRequests}, ${limited.usedRequests ?? "?"} used this period, ${limited.remainingRequests ?? "?"} request(s) left. Send the PATCH above, then run this again.`);
    return { lines, code: 1 };
  }
  lines.push(`verified: GET /key/budget on "${doc.key}" reads no request limit${budget.remainingUsd !== undefined ? ` · $${budget.remainingUsd.toFixed(4)} left` : ""}.`);
  return { lines, code: 0 };
}
