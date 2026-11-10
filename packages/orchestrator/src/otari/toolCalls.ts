// Typed view of a response's top-level `otari_tool_calls` array. Evidence for a
// gateway-run tool is one of these entries, never the model's claim.
export type OtariToolCallStatus = "in_progress" | "completed" | "failed";

export interface OtariToolError {
  provider: string | null;
  status: number | null;
  tag: string | null;
  retryable: boolean;
}

interface Base {
  id: string;
  status: OtariToolCallStatus;
  truncated?: boolean;
  error?: OtariToolError;
}
export interface OtariSearchCall extends Base {
  type: "web_search";
  query: string;
  sources: { url: string; title?: string; published_date?: string }[];
}
export interface OtariFetchCall extends Base {
  type: "web_fetch";
  url: string;
  sources: { url: string; title?: string; published_date?: string }[];
}
export interface OtariCodeCall extends Base {
  type: "code_execution";
  code: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  file_ids: string[];
}
export interface OtariMcpCall extends Base {
  type: "mcp";
  server: string;
  name: string;
  output: string;
}
export type OtariToolCall = OtariSearchCall | OtariFetchCall | OtariCodeCall | OtariMcpCall;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function status(v: unknown): OtariToolCallStatus {
  return v === "completed" || v === "failed" || v === "in_progress" ? v : "failed";
}
function sources(v: unknown): { url: string; title?: string; published_date?: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { url: string; title?: string; published_date?: string }[] = [];
  for (const s of v) {
    if (!isObj(s) || typeof s["url"] !== "string") continue;
    const e: { url: string; title?: string; published_date?: string } = { url: s["url"] };
    if (typeof s["title"] === "string") e.title = s["title"];
    if (typeof s["published_date"] === "string") e.published_date = s["published_date"];
    out.push(e);
  }
  return out;
}
function error(v: unknown): OtariToolError | undefined {
  if (!isObj(v)) return undefined;
  return {
    provider: typeof v["provider"] === "string" ? v["provider"] : null,
    status: num(v["status"]),
    tag: typeof v["tag"] === "string" ? v["tag"] : null,
    retryable: v["retryable"] === true,
  };
}

/** Always returns an array; unknown or malformed entries are dropped, never thrown on. */
export function parseOtariToolCalls(raw: unknown): OtariToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: OtariToolCall[] = [];
  for (const e of raw) {
    if (!isObj(e) || typeof e["type"] !== "string") continue;
    const base: Base = { id: str(e["id"]), status: status(e["status"]) };
    if (e["truncated"] === true) base.truncated = true;
    const err = error(e["error"]);
    if (err) base.error = err;
    switch (e["type"]) {
      case "web_search":
        out.push({ ...base, type: "web_search", query: str(e["query"]), sources: sources(e["sources"]) });
        break;
      case "web_fetch":
        out.push({ ...base, type: "web_fetch", url: str(e["url"]), sources: sources(e["sources"]) });
        break;
      case "code_execution":
        out.push({
          ...base,
          type: "code_execution",
          code: str(e["code"]),
          stdout: str(e["stdout"]),
          stderr: str(e["stderr"]),
          exit_code: num(e["exit_code"]),
          file_ids: strs(e["file_ids"]),
        });
        break;
      case "mcp":
        out.push({ ...base, type: "mcp", server: str(e["server"]), name: str(e["name"]), output: str(e["output"]) });
        break;
      default:
        break;
    }
  }
  return out;
}
