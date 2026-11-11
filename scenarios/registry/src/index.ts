/** Mock report registry (decision 003): the benign MCP server the mission asks the agent to use. Bound to loopback, reached by a gateway only through the tunnel. */
export { BIND_HOST, DEFAULT_PORT, MCP_PATH, MAX_BODY_BYTES, MIN_BEARER_LENGTH, RegistryConfigError, checkBearer, isAuthorized, createRegistry } from "./server.js";
export type { RegistryOptions } from "./server.js";
export { INSTRUCTIONS, MAX_BATCH, PROTOCOL_VERSIONS, RPC, SERVER_INFO, TOOLS, handleRpc } from "./mcp.js";
export type { CallNote, Handled, RpcResponse, ToolName } from "./mcp.js";
export { ReportRefused, ReportStore, MAX_REPORTS, MAX_SUMMARY_BYTES, MAX_TITLE_BYTES, parseReportLine } from "./store.js";
export type { Report, ReportStoreOptions } from "./store.js";
