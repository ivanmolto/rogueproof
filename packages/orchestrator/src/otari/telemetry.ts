// Telemetry read side of the Otari gateway: what a workspace API key can read back
// about its own traffic. Spike 1.5 (hosted otari.ai, gateway 0.42.0, 2026-11-10):
//
//   GET /key/usage/summary        200  the calling key's own spend, tokens, requests
//   GET /usage/requests/{id}      200  settled cost of one request the key made
//   GET /end-users/{external_id}  200  service key only: spend of one end user
//   GET /key/budget               200  what the calling key may still spend
//   GET /traces                   401  "Invalid master key"
//   GET /organizations/me/usage   401  "Invalid master key"
//   GET /usage (row level)        401  "Invalid master key"
//
// Every reader resolves to `{available: true, …}` or `{available: false, reason}`;
// nothing here throws on a gateway answer and nothing is retried. The endpoints
// that need the master key are still called, so the day hosted opens them (or a
// self-hosted gateway is used) the same code returns data.
import { ROLES, type OtariEnv, type Role } from "./env.js";
import { redact, redactString } from "./redact.js";

const TIMEOUT_MS = 15_000;

export interface Unavailable {
  available: false;
  reason: string;
  /** HTTP status when the gateway answered; undefined on a transport failure. */
  status: number | undefined;
}
export type Telemetry<T> = ({ available: true } & T) | Unavailable;

export interface UsageTotals {
  cost: number;
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export interface UsageGroup {
  key: string;
  label: string | undefined;
  cost: number;
  tokens: number;
  requests: number;
}
export interface KeyUsage {
  totals: UsageTotals;
  byModel: UsageGroup[];
  /** For the service key: one group per end user (label = external id) plus the key's own user. */
  byUser: UsageGroup[];
  byProvider: UsageGroup[];
  byTool: UsageGroup[];
}
export interface UsageReport {
  /** Per-key summaries: hosted has no workspace-wide read for an API key. */
  scope: "keys";
  since: string;
  until: string;
  totals: UsageTotals;
  byRole: Partial<Record<Role, KeyUsage>>;
}
export interface RequestUsage {
  requestId: string;
  /** "success" or the gateway's error status for the request. */
  status: string;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export interface TraceSummary {
  traceId: string;
  name: string | undefined;
  startedAt: string | undefined;
  stepCount: number | undefined;
  errorCount: number | undefined;
  cost: number | undefined;
}
export interface EndUserSpend {
  endUser: string;
  /** USD spent in the end user's current budget period. */
  spend: number;
  reserved: number;
  requests: number;
  tokens: number;
  blocked: boolean;
  budgetId: string | undefined;
}

export interface KeyBudgetLimit {
  scope: string;
  limitUsd: number | undefined;
  remainingUsd: number | undefined;
  limitRequests: number | undefined;
  remainingRequests: number | undefined;
}
export interface KeyBudget {
  enforced: boolean;
  /** USD the key may still spend; undefined when no USD limit applies. */
  remainingUsd: number | undefined;
  limits: KeyBudgetLimit[];
}

export interface OtariTelemetryOptions {
  env: OtariEnv;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

type Raw = { ok: true; body: unknown } | { ok: false; unavailable: Unavailable };

export class OtariTelemetry {
  private readonly env: OtariEnv;
  private readonly fetch: typeof fetch;

  constructor(opts: OtariTelemetryOptions) {
    this.env = opts.env;
    this.fetch = opts.fetch ?? fetch;
  }

  /** Spend, tokens and request counts since `since`, per role key, with their sum. */
  async getUsage(since: Date, o: { until?: Date; roles?: readonly Role[] } = {}): Promise<Telemetry<UsageReport>> {
    const until = o.until ?? new Date();
    const query = new URLSearchParams({ start_date: since.toISOString(), end_date: until.toISOString() });
    for (const d of ["model", "user", "provider", "tool"]) query.append("dimensions", d);
    const byRole: Partial<Record<Role, KeyUsage>> = {};
    const totals: UsageTotals = { cost: 0, requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (const role of o.roles ?? ROLES) {
      const raw = await this.get(role, `/key/usage/summary?${query.toString()}`);
      if (!raw.ok) return { ...raw.unavailable, reason: `key "${role}": ${raw.unavailable.reason}` };
      const usage = parseKeyUsage(raw.body);
      if (!usage) return unexpectedShape(`key "${role}": GET /key/usage/summary`);
      byRole[role] = usage;
      for (const k of Object.keys(totals) as (keyof UsageTotals)[]) totals[k] += usage.totals[k];
    }
    return { available: true, scope: "keys", since: since.toISOString(), until: until.toISOString(), totals, byRole };
  }

  /** Settled cost of one request, by its Otari-Request-ID. Only the key that made it may ask. */
  async getRequestUsage(role: Role, requestId: string): Promise<Telemetry<RequestUsage>> {
    const raw = await this.get(role, `/usage/requests/${encodeURIComponent(requestId)}`);
    if (!raw.ok) return raw.unavailable;
    const usage = parseRequestUsage(raw.body);
    return usage ? { available: true, ...usage } : unexpectedShape("GET /usage/requests/{id}");
  }

  /** Agent traces since `since`. Hosted answers 401 to an API key (master key only). */
  async getTraces(since: Date, o: { role?: Role; limit?: number } = {}): Promise<Telemetry<{ traces: TraceSummary[]; hasMore: boolean }>> {
    const query = new URLSearchParams({ start: since.toISOString(), limit: String(o.limit ?? 50) });
    const raw = await this.get(o.role ?? "agent", `/traces?${query.toString()}`);
    if (!raw.ok) return raw.unavailable;
    const list = parseTraceList(raw.body);
    return list ? { available: true, ...list } : unexpectedShape("GET /traces");
  }

  /** Organization-wide usage since `since`. Hosted answers 401 to an API key (master key only). */
  async getOrganizationUsage(since: Date, o: { role?: Role } = {}): Promise<Telemetry<{ totals: UsageTotals }>> {
    const query = new URLSearchParams({ start_date: since.toISOString() });
    query.append("dimensions", "none");
    const raw = await this.get(o.role ?? "agent", `/organizations/me/usage/summary?${query.toString()}`);
    if (!raw.ok) return raw.unavailable;
    const usage = parseKeyUsage(raw.body);
    return usage ? { available: true, totals: usage.totals } : unexpectedShape("GET /organizations/me/usage/summary");
  }

  /** Spend of one end user of the service key (the id sent in the `user` field). */
  async getEndUserSpend(endUser: string): Promise<Telemetry<EndUserSpend>> {
    const raw = await this.get("service", `/end-users/${encodeURIComponent(endUser)}`);
    if (!raw.ok) return raw.unavailable;
    const spend = parseEndUser(raw.body);
    return spend ? { available: true, ...spend } : unexpectedShape("GET /end-users/{external_id}");
  }

  /** What the role's key may still spend (USD and, on a request-limited budget, requests). */
  async getKeyBudget(role: Role): Promise<Telemetry<KeyBudget>> {
    const raw = await this.get(role, "/key/budget");
    if (!raw.ok) return raw.unavailable;
    const budget = parseKeyBudget(raw.body);
    return budget ? { available: true, ...budget } : unexpectedShape("GET /key/budget");
  }

  private async get(role: Role, path: string): Promise<Raw> {
    let res: Response;
    try {
      res = await this.fetch(this.env.baseURL.replace(/\/$/, "") + path, {
        method: "GET",
        headers: { authorization: `Bearer ${this.env.keys[role]}`, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, unavailable: { available: false, reason: redactString(`transport: ${message}`), status: undefined } };
    }
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = undefined;
    }
    if (!res.ok) return { ok: false, unavailable: { available: false, reason: reasonFor(res.status, body), status: res.status } };
    return { ok: true, body: redact(body) };
  }
}

function unexpectedShape(what: string): Unavailable {
  return { available: false, reason: `${what} answered 200 with an unexpected body shape`, status: 200 };
}

/** Human-readable reason for a refusal, from the gateway's `{detail}` body. Never contains a key. */
export function reasonFor(status: number, body: unknown): string {
  const b = isRecord(body) ? body : {};
  const d = b["detail"];
  const detail = typeof d === "string" ? d : d === undefined ? "" : JSON.stringify(d);
  let hint = "";
  if (status === 401 && /master key/i.test(detail)) hint = "needs the master key, which a hosted workspace API key is not; ";
  else if (status === 403 && /service key/i.test(detail)) hint = "needs a service key; ";
  else if (status === 404) hint = "not found, not yet settled, or owned by another key; ";
  return redactString(`${hint}HTTP ${status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
}

// ---- parsers of gateway bodies (external input: total, never throw; fuzzed) ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** A finite number from a JSON number or a numeric string (`cost_usd` is a string). */
function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function parseGroups(v: unknown): UsageGroup[] {
  if (!Array.isArray(v)) return [];
  const out: UsageGroup[] = [];
  for (const g of v) {
    if (!isRecord(g)) continue;
    const cost = num(g["cost"]);
    if (cost === undefined) continue;
    out.push({ key: str(g["key"]) ?? "", label: str(g["label"]), cost, tokens: num(g["tokens"]) ?? 0, requests: num(g["requests"]) ?? 0 });
  }
  return out;
}

/** Body of GET /key/usage/summary (and the organization summary, same shape). */
export function parseKeyUsage(body: unknown): KeyUsage | undefined {
  if (!isRecord(body) || !isRecord(body["totals"])) return undefined;
  const t = body["totals"];
  const cost = num(t["cost"]);
  const requests = num(t["request_count"]);
  if (cost === undefined || requests === undefined) return undefined;
  return {
    totals: {
      cost,
      requests,
      errors: num(t["error_count"]) ?? 0,
      promptTokens: num(t["prompt_tokens"]) ?? 0,
      completionTokens: num(t["completion_tokens"]) ?? 0,
      totalTokens: num(t["total_tokens"]) ?? 0,
    },
    byModel: parseGroups(body["by_model"]),
    byUser: parseGroups(body["by_user"]),
    byProvider: parseGroups(body["by_provider"]),
    byTool: parseGroups(body["by_tool"]),
  };
}

/** Body of GET /usage/requests/{request_id}. */
export function parseRequestUsage(body: unknown): RequestUsage | undefined {
  if (!isRecord(body)) return undefined;
  const requestId = str(body["request_id"]);
  const cost = num(body["cost_usd"]);
  if (requestId === undefined || cost === undefined) return undefined;
  return {
    requestId,
    status: str(body["status"]) ?? "unknown",
    cost,
    promptTokens: num(body["prompt_tokens"]) ?? 0,
    completionTokens: num(body["completion_tokens"]) ?? 0,
    totalTokens: num(body["total_tokens"]) ?? 0,
  };
}

/** Body of GET /end-users/{external_id}. */
export function parseEndUser(body: unknown): EndUserSpend | undefined {
  if (!isRecord(body)) return undefined;
  const endUser = str(body["external_id"]);
  const spend = num(body["spend"]);
  if (endUser === undefined || spend === undefined) return undefined;
  return {
    endUser,
    spend,
    reserved: num(body["reserved"]) ?? 0,
    requests: num(body["current_requests"]) ?? 0,
    tokens: num(body["current_tokens"]) ?? 0,
    blocked: body["blocked"] === true,
    budgetId: str(body["budget_id"]),
  };
}

/** Body of GET /key/budget (shape seen live in spike 1.5). */
export function parseKeyBudget(body: unknown): KeyBudget | undefined {
  if (!isRecord(body) || typeof body["budgets_enforced"] !== "boolean") return undefined;
  const limits: KeyBudgetLimit[] = [];
  for (const l of Array.isArray(body["limits"]) ? body["limits"] : []) {
    if (!isRecord(l)) continue;
    limits.push({
      scope: str(l["scope"]) ?? "",
      limitUsd: num(l["limit_usd"]),
      remainingUsd: num(l["remaining_usd"]),
      limitRequests: num(l["limit_requests"]),
      remainingRequests: num(l["remaining_requests"]),
    });
  }
  return { enforced: body["budgets_enforced"], remainingUsd: num(body["remaining_usd"]), limits };
}

/** Body of GET /traces: `{items, has_more}`. Shape from the gateway's OpenAPI; never seen live on hosted. */
export function parseTraceList(body: unknown): { traces: TraceSummary[]; hasMore: boolean } | undefined {
  if (!isRecord(body) || !Array.isArray(body["items"])) return undefined;
  const traces: TraceSummary[] = [];
  for (const item of body["items"]) {
    if (!isRecord(item)) continue;
    const traceId = str(item["trace_id"]);
    if (traceId === undefined) continue;
    traces.push({
      traceId,
      name: str(item["name"]),
      startedAt: str(item["started_at"]),
      stepCount: num(item["step_count"]),
      errorCount: num(item["error_count"]),
      cost: num(item["cost"]),
    });
  }
  return { traces, hasMore: body["has_more"] === true };
}
