/**
 * MCP Apps (`io.modelcontextprotocol/ui`, 2026-01-26): the method names Porthole speaks. The shell
 * is an MCP Apps view of its host; content may also use the official App SDK directly, so the host
 * side answers these whoever sends them. This module holds names and shapes only: the core's own
 * adapter (the subset the shell speaks) and the `/mcp` adapter (full MCP Apps views) both use it.
 */

export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

export const MCP_APPS_METHODS = {
  // View → host requests.
  initialize: "ui/initialize",
  message: "ui/message",
  openLink: "ui/open-link",
  downloadFile: "ui/download-file",
  requestDisplayMode: "ui/request-display-mode",
  updateModelContext: "ui/update-model-context",
  callTool: "tools/call",
  readResource: "resources/read",
  // View → host notifications.
  initialized: "ui/notifications/initialized",
  sizeChanged: "ui/notifications/size-changed",
  requestTeardown: "ui/notifications/request-teardown",
  log: "notifications/message",
  // Host → view notifications.
  toolInput: "ui/notifications/tool-input",
  toolInputPartial: "ui/notifications/tool-input-partial",
  toolResult: "ui/notifications/tool-result",
  toolCancelled: "ui/notifications/tool-cancelled",
  hostContextChanged: "ui/notifications/host-context-changed",
  // Host → view requests.
  resourceTeardown: "ui/resource-teardown",
  // Sandbox proxy (a second origin that relays between host and view).
  sandboxProxyReady: "ui/notifications/sandbox-proxy-ready",
  sandboxResourceReady: "ui/notifications/sandbox-resource-ready",
} as const;

export type McpAppsMethod = (typeof MCP_APPS_METHODS)[keyof typeof MCP_APPS_METHODS];

/**
 * What the shell's `tool-input(-partial)` carries: the content to draw. Porthole's own argument
 * names, since the shell is the only view that reads them.
 */
export interface ShellToolInput {
  readonly html: string;
}

/** The logger name the shell's error reports (`notifications/message`, level `error`) carry. */
export const SHELL_LOGGER = "porthole";

/**
 * The host context a view receives in `ui/initialize`'s result and in `host-context-changed`
 * (the fields Porthole sets; the spec allows more, which views ignore).
 */
export interface HostContext {
  readonly theme: "light" | "dark";
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly displayMode: "inline" | "fullscreen" | "pip";
  readonly availableDisplayModes: readonly ("inline" | "fullscreen" | "pip")[];
  readonly containerDimensions?: { readonly maxWidth?: number; readonly maxHeight?: number };
  readonly locale?: string;
  readonly timeZone?: string;
  readonly platform?: "web" | "desktop" | "mobile";
  readonly deviceCapabilities?: { readonly touch?: boolean; readonly hover?: boolean };
  readonly [key: string]: unknown;
}
