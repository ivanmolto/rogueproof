// Every gateway call resolves to exactly one outcome. Models never influence this;
// it is read from the HTTP status, the Otari-* headers and the response body.
import { OUTCOMES } from "@rogueproof/shared";
import type { OtariToolCall } from "./toolCalls.js";

export type Outcome = (typeof OUTCOMES)[number];

export interface Classified {
  outcome: Outcome;
  /** Otari-Fallback: true on this response (also set when outcome is tool_error). */
  fallback: boolean;
  /** Only meaningful for `error`: the gateway says waiting may help. */
  retryable: boolean;
  /** Seconds from Retry-After when present. */
  retryAfterSeconds: number | undefined;
  /** Otari-Error-Code header or body `code`. */
  code: string | undefined;
  detail: string | undefined;
}

const RETRYABLE_CODES = new Set(["rate_limited", "upstream_rate_limited", "provider_error", "provider_stream_interrupted"]);
const BUDGET_CODES = new Set(["budget_exceeded", "insufficient_funds"]);
const GUARDRAIL_CODES = new Set(["guardrail_violation"]);

function header(h: Record<string, string>, name: string): string | undefined {
  return h[name.toLowerCase()];
}

function parseRetryAfter(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Classify a successful (2xx) response. */
export function classifySuccess(headers: Record<string, string>, toolCalls: readonly OtariToolCall[]): Classified {
  const fallback = header(headers, "otari-fallback") === "true";
  const failed = toolCalls.some((c) => c.status === "failed");
  return {
    outcome: failed ? "tool_error" : fallback ? "fallback" : "ok",
    fallback,
    retryable: false,
    retryAfterSeconds: undefined,
    code: undefined,
    detail: undefined,
  };
}

/** Classify an HTTP error response. */
export function classifyError(status: number, headers: Record<string, string>, body: unknown): Classified {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const nested = (b["error"] && typeof b["error"] === "object" ? b["error"] : {}) as Record<string, unknown>;
  const code = header(headers, "otari-error-code") ?? (typeof b["code"] === "string" ? b["code"] : undefined) ?? (typeof nested["code"] === "string" ? nested["code"] : undefined);
  const detailRaw = b["detail"] ?? nested["message"] ?? b["message"];
  const detail = typeof detailRaw === "string" ? detailRaw : detailRaw === undefined ? undefined : JSON.stringify(detailRaw);
  const retryAfterSeconds = parseRetryAfter(header(headers, "retry-after"));
  const base = { fallback: false, retryAfterSeconds, code, detail };

  if (code && GUARDRAIL_CODES.has(code)) return { ...base, outcome: "guardrail_blocked", retryable: false };
  if ((code && BUDGET_CODES.has(code)) || status === 402) return { ...base, outcome: "budget_exceeded", retryable: false };
  if (status === 429 && header(headers, "otari-rate-limit-rule") === "budget") return { ...base, outcome: "budget_exceeded", retryable: false };
  if (status === 403 && header(headers, "otari-budget-scope")) return { ...base, outcome: "budget_exceeded", retryable: false };

  const retryable = (code !== undefined && RETRYABLE_CODES.has(code)) || status === 429 || status === 502 || status === 503 || status === 504;
  return { ...base, outcome: "error", retryable };
}

/** A transport failure (no HTTP response at all). */
export function classifyTransportError(message: string): Classified {
  return { outcome: "error", fallback: false, retryable: true, retryAfterSeconds: undefined, code: "transport", detail: message };
}
