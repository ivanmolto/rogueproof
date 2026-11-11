// The `Otari-Guardrails` response header: what Otari's inference guardrail said
// about a served request. It is a JSON array, one entry per guardrail profile
// (seen live 2026-11-11 with the mandate in Monitor). A blocked request is a
// 403 without this header; that is the `guardrail_blocked` outcome instead.
export interface GuardrailVerdict {
  profile: string;
  /** "monitor" or "block" as the gateway reports it. */
  mode: string;
  /** False when the guardrail flagged the request. */
  valid: boolean;
  score: number | undefined;
  status: string;
}

export const GUARDRAILS_HEADER = "otari-guardrails";

/** Parses the header value. External input: never throws; entries without a boolean `valid` are dropped. */
export function parseGuardrailVerdicts(header: string | undefined): GuardrailVerdict[] {
  if (header === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: GuardrailVerdict[] = [];
  for (const v of parsed) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    const r = v as Record<string, unknown>;
    if (typeof r["valid"] !== "boolean") continue;
    const score = r["score"];
    out.push({
      profile: typeof r["profile"] === "string" ? r["profile"] : "",
      mode: typeof r["mode"] === "string" ? r["mode"] : "",
      valid: r["valid"],
      score: typeof score === "number" && Number.isFinite(score) ? score : undefined,
      status: typeof r["status"] === "string" ? r["status"] : "",
    });
  }
  return out;
}
