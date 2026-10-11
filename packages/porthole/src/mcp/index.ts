/**
 * `@botiverse/porthole/mcp`: the MCP Apps adapter for full MCP Apps views (P007): the host-side
 * subset of the protocol beyond what the shell speaks (tool results and cancellation, tools/call
 * and resources/read through the bridge, display modes, model context, the sandbox-proxy
 * handshake, teardown), implemented as a `ProtocolAdapter` against the core's seams. It depends on
 * the core only, never on the MCP SDK.
 *
 * Built by the MCP adapter work; until then this entry re-exports what that work builds against.
 */
export type {
  AdapterConnection,
  AdapterEvent,
  AdapterSession,
  ProtocolAdapter,
} from "../protocol/adapter.ts";
export type { HostContext } from "../protocol/mcp-apps.ts";
export { MCP_APPS_METHODS, MCP_APPS_PROTOCOL_VERSION } from "../protocol/mcp-apps.ts";
export {
  JSON_RPC_ERRORS,
  parseJsonRpc,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../protocol/jsonrpc.ts";
