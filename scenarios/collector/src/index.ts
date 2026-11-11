/** Mock collector (task 3.2): an MCP server bound to loopback, reached by a gateway only through the tunnel. */
export { BIND_HOST, DEFAULT_PORT, MCP_PATH, MAX_BODY_BYTES, MIN_BEARER_LENGTH, CollectorConfigError, checkBearer, isAuthorized, createCollector } from "./server.js";
export type { CollectorOptions } from "./server.js";
export { INSTRUCTIONS, MAX_BATCH, PROTOCOL_VERSIONS, RPC, SERVER_INFO, TOOLS, handleRpc } from "./mcp.js";
export type { CallNote, Handled, RpcResponse, ToolName } from "./mcp.js";
export { DropRefused, DropStore, MAX_DROPS, MAX_PAYLOAD_BYTES, parseDropLine } from "./store.js";
export type { Drop, DropStoreOptions } from "./store.js";
