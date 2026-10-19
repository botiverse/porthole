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
  // MCP's own resource subscriptions (P079), which MCP Apps doesn't list: the view is the host's
  // MCP client here, as for resources/read.
  subscribeResource: "resources/subscribe",
  unsubscribeResource: "resources/unsubscribe",
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
  resourceUpdated: "notifications/resources/updated",
  // Host → view requests.
  resourceTeardown: "ui/resource-teardown",
  // Sandbox proxy (a second origin that relays between host and view).
  sandboxProxyReady: "ui/notifications/sandbox-proxy-ready",
  sandboxResourceReady: "ui/notifications/sandbox-resource-ready",
} as const;

export type McpAppsMethod = (typeof MCP_APPS_METHODS)[keyof typeof MCP_APPS_METHODS];

/**
 * What a host that declares `setModelContext` says it takes (`hostCapabilities.updateModelContext`),
 * in both adapters: text blocks and structured content, exactly what the bridge accepts and the
 * person is shown (P100). Images and other blocks aren't offered, and are refused.
 */
export const MODEL_CONTEXT_OFFERED = { text: {}, structuredContent: {} } as const;

/**
 * What the shell's `tool-input(-partial)` carries: the content to draw. Porthole's own argument
 * names, since the shell is the only view that reads them.
 */
export interface ShellToolInput {
  readonly html: string;
}

/**
 * The style variables MCP Apps defines (`McpUiStyleVariableKey`, 2026-01-26). The official App SDK
 * refuses a host context whose `styles.variables` holds any other name ("Unrecognized key"), so a
 * host sends exactly these there; Porthole's own names go under `PORTHOLE_STYLES` instead.
 */
export const MCP_APPS_STYLE_VARIABLES: readonly string[] = [
  ...["background", "text", "border", "ring"].flatMap((kind) =>
    (kind === "background"
      ? [
          "primary",
          "secondary",
          "tertiary",
          "inverse",
          "ghost",
          "info",
          "danger",
          "success",
          "warning",
          "disabled",
        ]
      : kind === "text"
        ? [
            "primary",
            "secondary",
            "tertiary",
            "inverse",
            "ghost",
            "info",
            "danger",
            "success",
            "warning",
            "disabled",
          ]
        : kind === "border"
          ? [
              "primary",
              "secondary",
              "tertiary",
              "inverse",
              "ghost",
              "info",
              "danger",
              "success",
              "warning",
              "disabled",
            ]
          : ["primary", "secondary", "inverse", "info", "danger", "success", "warning"]
    ).map((name) => `--color-${kind}-${name}`),
  ),
  "--font-sans",
  "--font-mono",
  ...["normal", "medium", "semibold", "bold"].map((weight) => `--font-weight-${weight}`),
  ...["xs", "sm", "md", "lg"].map((size) => `--font-text-${size}-size`),
  ...["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].map((size) => `--font-heading-${size}-size`),
  ...["xs", "sm", "md", "lg"].map((size) => `--font-text-${size}-line-height`),
  ...["xs", "sm", "md", "lg", "xl", "2xl", "3xl"].map(
    (size) => `--font-heading-${size}-line-height`,
  ),
  ...["xs", "sm", "md", "lg", "xl", "full"].map((size) => `--border-radius-${size}`),
  "--border-width-regular",
  ...["hairline", "sm", "md", "lg"].map((size) => `--shadow-${size}`),
];

/**
 * The host context's own-prefixed field for the theme variables MCP Apps doesn't define (an
 * accent, a chart palette): `{ variables }`. The shell applies them with the standard ones; a view
 * that doesn't know the field ignores it (the host context is open to extra fields).
 */
export const PORTHOLE_STYLES = "porthole/styles";

/**
 * Porthole's own request for copying text (`copyText`, P052): `{ text }`, answered `{}` when the
 * host copied it and `{ isError: true }` when it didn't. The standard has no clipboard request.
 */
export const COPY_TEXT_METHOD = "porthole/copy-text";

/**
 * The `_meta` key that marks a `resources/read` result as the host's cached copy (P079): stale,
 * with the fresh one to follow as `notifications/resources/updated`. Only for a resource the view
 * subscribes to.
 */
export const STALE_META = "porthole/stale";

/**
 * Porthole's own notification from the shell (P080): it cancelled a navigation of the frame to
 * `{ url }` (P079). The content's word, sent only where `reportError` is declared, and counted as
 * one of its reports; the host's adapter carries it into `reportError`.
 */
export const NAVIGATION_BLOCKED_METHOD = "porthole/navigation-blocked";

/**
 * Porthole's own notification from the shell (P084): a page that came with files is opening
 * another page of its set, `{ url }`, in the frame; and, as it arrives, the page a navigation
 * opened says so, `{ url, arrived: true }` (P098). The host takes the frame's next load (or the
 * load it came after, within `LATE_NOTICE_MS`) for that page rather than for content that left
 * (P031). The content's word: it only spares a restart.
 */
export const NAVIGATING_METHOD = "porthole/navigating";

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
  /** Porthole's own theme variables, outside the spec's list (`PORTHOLE_STYLES`). */
  readonly "porthole/styles"?: { readonly variables: Readonly<Record<string, string>> };
  readonly [key: string]: unknown;
}
