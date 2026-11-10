// Tool declarations the client accepts, and the one rule about combining them.
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

export type OtariWebFetchTool = { type: "otari_web_fetch" };
export type OtariWebSearchTool = { type: "otari_web_search"; max_uses?: number };
export type OtariCodeExecutionTool = { type: "otari_code_execution"; container?: string };
export type GatewayTool = OtariWebFetchTool | OtariWebSearchTool | OtariCodeExecutionTool;
export type FunctionTool = ChatCompletionFunctionTool;
export type Tool = FunctionTool | GatewayTool;

export const WEB_TOOL_TYPES = ["otari_web_fetch", "otari_web_search"] as const;

export function isWebTool(t: Tool): t is OtariWebFetchTool | OtariWebSearchTool {
  return (WEB_TOOL_TYPES as readonly string[]).includes(t.type);
}
export function isCodeExecutionTool(t: Tool): t is OtariCodeExecutionTool {
  return t.type === "otari_code_execution";
}
export function isGatewayTool(t: Tool): t is GatewayTool {
  return isWebTool(t) || isCodeExecutionTool(t);
}

export class ToolSetError extends Error {
  override readonly name = "ToolSetError";
}

/**
 * The phased-loop rule, in one place: a request never carries a web tool together
 * with code execution or MCP servers. Research turns carry web tools; act turns
 * carry local function tools plus MCP; report calls carry code execution only.
 * Enforced before sending so a mixed request never reaches the gateway.
 */
export function assertToolSetAllowed(tools: readonly Tool[] | undefined, mcpServerIds: readonly string[] | undefined): void {
  const list = tools ?? [];
  const hasWeb = list.some(isWebTool);
  const hasCode = list.some(isCodeExecutionTool);
  const hasMcp = (mcpServerIds?.length ?? 0) > 0;
  if (hasWeb && hasCode) throw new ToolSetError("a request cannot combine web tools with otari_code_execution");
  if (hasWeb && hasMcp) throw new ToolSetError("a request cannot combine web tools with mcp_server_ids");
  for (const t of list) {
    if (t.type === "otari_web_search" && t.max_uses !== undefined && (!Number.isInteger(t.max_uses) || t.max_uses < 0)) {
      throw new ToolSetError("otari_web_search.max_uses must be a non-negative integer");
    }
  }
}
