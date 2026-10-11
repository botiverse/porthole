/**
 * `@botiverse/porthole/mcp`: the MCP Apps adapter for full MCP Apps views (P007): the host-side
 * subset of the protocol (the handshake and host context, tool input and result, cancellation,
 * teardown, sizes and errors; `ui/message`, `ui/open-link`, `ui/download-file`, `tools/call`,
 * `resources/read` and `ui/update-model-context` through the bridge; the sandbox-proxy handshake),
 * implemented as a `ProtocolAdapter` against the core's seams. It depends on the core only, never
 * on the MCP SDK.
 *
 *   const view = readViewResource(await client.readResource({ uri }));
 *   const host = createHost(presets.mcpApp({ egress: view.egress, capabilities: { callTool: {} } }), {
 *     adapter: mcpAppsAdapter(),
 *     handlers: { callTool: ({ name, arguments: args }) => client.callTool({ name, arguments: args }) },
 *   });
 *   const display = host.mount(element, { displayId, title, scheme, document: view.html });
 *   display.sendToolInput(args);
 *   display.sendToolResult(await client.callTool({ name, arguments: args }));
 *
 * Tool visibility (`_meta.ui.visibility`) is the host's policy: its `callTool` handler refuses a
 * tool the view may not call.
 */
export {
  mcpAppsAdapter,
  viewHostContext,
  type McpAppConnection,
  type McpAppsAdapterOptions,
  type ToolInfo,
  type ToolResult,
} from "./adapter.ts";
export { sandboxProxyDocument } from "./proxy.ts";
export { VIEW_MIME_TYPE, readViewResource, viewEgress, type ViewResource } from "./view.ts";
export type {
  AdapterConnection,
  AdapterEvent,
  AdapterSession,
  ProtocolAdapter,
} from "../protocol/adapter.ts";
export type { HostContext } from "../protocol/mcp-apps.ts";
export {
  MCP_APPS_METHODS,
  MCP_APPS_PROTOCOL_VERSION,
  MCP_APPS_STYLE_VARIABLES,
  PORTHOLE_STYLES,
} from "../protocol/mcp-apps.ts";
export {
  JSON_RPC_ERRORS,
  parseJsonRpc,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../protocol/jsonrpc.ts";
