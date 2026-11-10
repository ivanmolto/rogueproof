// Redaction for anything that gets recorded or printed. Key shapes: the issued
// otk_v1_<region>_… workspace keys, the tk-/gw_ shapes the plan assumed, sk-
// provider keys, and bearer tokens. Header names that carry credentials are
// dropped entirely.
const KEY_PATTERNS: RegExp[] = [
  /\botk_v1_[a-z]{2,3}_[A-Za-z0-9_-]{6,}/g,
  /\btk-[A-Za-z0-9_-]{6,}/g,
  /\bgw_[A-Za-z0-9_-]{6,}/g,
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
const SECRET_HEADERS = new Set(["authorization", "otari-key", "x-api-key", "proxy-authorization", "cookie", "set-cookie"]);

export const REDACTED = "[REDACTED]";

export function redactString(s: string): string {
  let out = s;
  for (const re of KEY_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** Deep-copies `value`, redacting strings and dropping credential headers by name. */
export function redact<T>(value: T): T {
  return walk(value) as T;
}

function walk(v: unknown): unknown {
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? REDACTED : walk(x);
    }
    return out;
  }
  return v;
}

/** Keep only Otari-* and a few standard headers, redacted. */
export function pickResponseHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (key.startsWith("otari-") || key === "retry-after" || key === "server-timing" || key === "content-type") {
      out[key] = redactString(v);
    }
  }
  return out;
}
