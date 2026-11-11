// The only Otari gateway in the repo. One OpenAI-compatible client per role,
// pointed at OTARI_BASE_URL, with bounded retries, outcome classification and
// redacted records. Nothing outside src/otari/ may construct a client.
import OpenAI, { APIError } from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { ROLES, type OtariEnv, type Role } from "./env.js";
import { resolveModel } from "./models.js";
import { classifyError, classifySuccess, classifyTransportError, type Classified, type Outcome } from "./outcome.js";
import { pickResponseHeaders } from "./redact.js";
import { Recorder } from "./records.js";
import { assertToolSetAllowed, type Tool } from "./tools.js";
import { parseOtariToolCalls, type OtariToolCall } from "./toolCalls.js";

/** A chat message as the gateway accepts it. Re-exported so no other module imports the SDK. */
export type ChatMessage = ChatCompletionMessageParam;

/** How otari.ai expects an end user to be named for per-user budgets (docs: the `user` field). */
export const END_USER_FIELD = "user" as const;

export const MAX_MODEL_CALLS_PER_RUN = 40;
export const DEFAULT_MAX_TOKENS = 1024;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_SECONDS = 10;

export interface ChatOptions {
  model?: string;
  endUser?: string;
  tools?: Tool[];
  mcpServerIds?: string[];
  maxTokens?: number;
  temperature?: number;
  /** Per-run call counter; when it reaches the cap the call is not sent and outcome is step_cap. */
  counter?: RunCounter;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  outcome: Outcome;
  /** Otari-Fallback: true on this response. */
  fallback: boolean;
  response: ChatCompletion | undefined;
  /** Otari-* (plus retry-after, server-timing, content-type), lower-cased, redacted. */
  headers: Record<string, string>;
  usage: Usage;
  /** From usage.cost_usd when the gateway reports it. */
  cost: number | undefined;
  otariToolCalls: OtariToolCall[];
  requestId: string | undefined;
  model: string;
  status: number | undefined;
  latencyMs: number;
  attempts: number;
  error: { code: string | undefined; detail: string | undefined } | undefined;
}

/** Counts model calls in one run; the loop ends with step_cap when the cap is reached. */
export class RunCounter {
  calls = 0;
  constructor(readonly cap = MAX_MODEL_CALLS_PER_RUN) {}
  get exhausted(): boolean {
    return this.calls >= this.cap;
  }
}

export interface OtariClientOptions {
  env: OtariEnv;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  recordFile?: string;
  sleep?: (ms: number) => Promise<void>;
}

type ChatBody = ChatCompletion & { otari_tool_calls?: unknown; usage?: ChatCompletion["usage"] & { cost_usd?: string; pricing_source?: string } };

export class OtariClient {
  readonly recorder: Recorder;
  private readonly clients: Record<Role, OpenAI>;
  private readonly env: OtariEnv;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: OtariClientOptions) {
    this.env = opts.env;
    this.recorder = new Recorder(opts.recordFile);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const base = { baseURL: opts.env.baseURL, maxRetries: 0, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
    this.clients = Object.fromEntries(ROLES.map((r) => [r, new OpenAI({ ...base, apiKey: opts.env.keys[r] })])) as Record<Role, OpenAI>;
  }

  get profile(): OtariEnv["profile"] {
    return this.env.profile;
  }

  /** Build the request body. Exposed for tests; throws ToolSetError on a disallowed tool mix. */
  buildRequest(role: Role, messages: ChatCompletionMessageParam[], o: ChatOptions = {}): ChatCompletionCreateParamsNonStreaming {
    assertToolSetAllowed(o.tools, o.mcpServerIds);
    if (o.endUser !== undefined && role !== "service") {
      throw new Error(`endUser may only be set on the service role (got "${role}"); a normal key may not name another user`);
    }
    const body: Record<string, unknown> = {
      model: o.model ?? resolveModel(this.env.profile, role),
      messages,
      max_tokens: o.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    // The hosted gateway answered 400 "temperature: Extra inputs are not permitted" on
    // 2026-11-10 (docs/DEVIATIONS.md), so temperature is sent only when asked for.
    if (o.temperature !== undefined) body["temperature"] = o.temperature;
    if (o.tools && o.tools.length > 0) body["tools"] = o.tools as unknown as ChatCompletionTool[];
    if (o.mcpServerIds && o.mcpServerIds.length > 0) body["mcp_server_ids"] = o.mcpServerIds;
    if (o.endUser !== undefined) body[END_USER_FIELD] = o.endUser;
    return body as unknown as ChatCompletionCreateParamsNonStreaming;
  }

  async chat(role: Role, messages: ChatCompletionMessageParam[], o: ChatOptions = {}): Promise<ChatResult> {
    const request = this.buildRequest(role, messages, o);
    const model = request.model;
    const empty: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    if (o.counter?.exhausted) {
      return this.finish(role, model, request, undefined, {
        outcome: "step_cap", fallback: false, retryable: false, retryAfterSeconds: undefined, code: "step_cap",
        detail: `run reached the ${o.counter.cap}-call cap`,
      }, {}, empty, undefined, [], undefined, 0, 0);
    }

    let attempt = 0;
    for (;;) {
      attempt++;
      if (o.counter) o.counter.calls++;
      const started = performance.now();
      let classified: Classified;
      let headers: Record<string, string> = {};
      let body: ChatBody | undefined;
      let status: number | undefined;
      try {
        const { data, response } = await this.clients[role].chat.completions
          .create(request, o.signal ? { signal: o.signal } : {})
          .withResponse();
        status = response.status;
        headers = pickResponseHeaders(response.headers);
        body = data as ChatBody;
        classified = classifySuccess(headers, parseOtariToolCalls(body.otari_tool_calls));
      } catch (e) {
        if (e instanceof APIError && typeof e.status === "number") {
          status = e.status;
          headers = pickResponseHeaders(e.headers ?? {});
          classified = classifyError(e.status, headers, e.error ?? safeJson(e.message));
        } else {
          classified = classifyTransportError(e instanceof Error ? e.message : String(e));
        }
      }
      const latencyMs = Math.round(performance.now() - started);

      // A retry is a model call too: never retry past the run's call cap.
      if (classified.outcome === "error" && classified.retryable && attempt <= MAX_RETRIES && !o.counter?.exhausted) {
        const wait = Math.min(classified.retryAfterSeconds ?? 2 ** attempt, MAX_RETRY_WAIT_SECONDS);
        this.recorder.add({ t: new Date().toISOString(), role, model, outcome: "error", fallback: false, status, latencyMs, requestId: headers["otari-request-id"], attempt, request, response: { code: classified.code, detail: classified.detail, retrying: true }, headers });
        await this.sleep(wait * 1000);
        continue;
      }

      const toolCalls = body ? parseOtariToolCalls(body.otari_tool_calls) : [];
      const usage: Usage = body?.usage
        ? { promptTokens: body.usage.prompt_tokens, completionTokens: body.usage.completion_tokens, totalTokens: body.usage.total_tokens }
        : empty;
      const cost = body?.usage?.cost_usd !== undefined ? Number(body.usage.cost_usd) : undefined;
      return this.finish(role, model, request, body, classified, headers, usage, Number.isFinite(cost) ? cost : undefined, toolCalls, status, latencyMs, attempt);
    }
  }

  private finish(
    role: Role, model: string, request: unknown, body: ChatBody | undefined, c: Classified,
    headers: Record<string, string>, usage: Usage, cost: number | undefined, toolCalls: OtariToolCall[],
    status: number | undefined, latencyMs: number, attempts: number,
  ): ChatResult {
    const requestId = headers["otari-request-id"];
    this.recorder.add({
      t: new Date().toISOString(), role, model, outcome: c.outcome, fallback: c.fallback, status, latencyMs, requestId,
      attempt: attempts, request, response: body ?? { code: c.code, detail: c.detail }, headers,
    });
    return {
      outcome: c.outcome, fallback: c.fallback, response: body, headers, usage, cost, otariToolCalls: toolCalls,
      requestId, model, status, latencyMs, attempts,
      error: c.outcome === "ok" || c.outcome === "fallback" ? undefined : { code: c.code, detail: c.detail },
    };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { detail: s };
  }
}
