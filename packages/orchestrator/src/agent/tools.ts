// The tool set of each phase, and the parser for local tool-call arguments.
import type { FunctionTool, Tool } from "../otari/index.js";
import { LOCAL_TOOL_NAMES, type LocalToolCall, type LocalToolName, type Phase } from "./types.js";

const fn = (name: LocalToolName, description: string, props: Record<string, string>): FunctionTool => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(props),
      properties: Object.fromEntries(Object.entries(props).map(([k, d]) => [k, { type: "string", description: d }])),
    },
  },
});

export const LOCAL_TOOLS: readonly FunctionTool[] = [
  fn("read_file", "Read a file in the workspace.", { path: "Path relative to the workspace root." }),
  fn("write_file", "Create or overwrite a file in the workspace.", {
    path: "Path relative to the workspace root.",
    content: "Full file content.",
  }),
  fn("run_command", "Run a shell command in the workspace. No network.", { cmd: "The command line." }),
];

export interface PhaseToolSet {
  tools: Tool[];
  mcpServerIds?: string[];
}

/**
 * The only place a request's tool set is built. Our own least-privilege rule
 * (the gateway accepts any mix): the turn that reads untrusted web content
 * holds no local tool and no MCP server; the turn that can act holds no web tool.
 */
export function toolSetFor(phase: Phase, mcpServerIds: readonly string[] = []): PhaseToolSet {
  switch (phase) {
    case "research":
      return { tools: [{ type: "otari_web_fetch" }, { type: "otari_web_search" }] };
    case "act":
      return mcpServerIds.length > 0 ? { tools: [...LOCAL_TOOLS], mcpServerIds: [...mcpServerIds] } : { tools: [...LOCAL_TOOLS] };
  }
}

export type ParsedToolCall = { ok: true; call: LocalToolCall } | { ok: false; error: string };

const isLocalToolName = (n: string): n is LocalToolName => (LOCAL_TOOL_NAMES as readonly string[]).includes(n);

/** Parses a model's function call. Model output is data: never throws, never guesses a missing argument. */
export function parseLocalToolCall(name: string, argsJson: string): ParsedToolCall {
  if (!isLocalToolName(name)) return { ok: false, error: `unknown tool "${name.slice(0, 80)}"` };
  let raw: unknown;
  try {
    raw = JSON.parse(argsJson);
  } catch {
    return { ok: false, error: `arguments for ${name} are not valid JSON` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `arguments for ${name} must be a JSON object` };
  }
  const a = raw as Record<string, unknown>;
  const need = (k: string): string | undefined => (typeof a[k] === "string" && a[k].length > 0 ? a[k] : undefined);
  switch (name) {
    case "read_file": {
      const path = need("path");
      return path === undefined ? { ok: false, error: "read_file needs a string `path`" } : { ok: true, call: { tool: name, path } };
    }
    case "write_file": {
      const path = need("path");
      if (path === undefined || typeof a["content"] !== "string") {
        return { ok: false, error: "write_file needs string `path` and `content`" };
      }
      return { ok: true, call: { tool: name, path, content: a["content"] } };
    }
    case "run_command": {
      const cmd = need("cmd");
      return cmd === undefined ? { ok: false, error: "run_command needs a string `cmd`" } : { ok: true, call: { tool: name, cmd } };
    }
  }
}
