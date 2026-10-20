import type { CallOutcome } from "../bridge/types.ts";
import { egressOrigins } from "../compile/policy.ts";
import type { CapabilityName } from "../config/capabilities.ts";
import {
  JSON_RPC_ERRORS,
  parseJsonRpc,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "../protocol/jsonrpc.ts";
import type { AdapterConnection, AdapterSession, ProtocolAdapter } from "../protocol/adapter.ts";
import {
  MCP_APPS_METHODS,
  MCP_APPS_PROTOCOL_VERSION,
  MODEL_CONTEXT_OFFERED,
  type HostContext,
} from "../protocol/mcp-apps.ts";
import {
  COPY_TEXT_METHOD,
  MCP_APPS_STYLE_VARIABLES,
  NAVIGATION_BLOCKED_METHOD,
} from "../protocol/mcp-apps.ts";
import { liveData } from "../protocol/live-data.ts";
import { messageText } from "../protocol/message-text.ts";
import { reasonFor } from "../bridge/refusal.ts";

/**
 * The MCP Apps adapter (P004, P007): the host side of the protocol for full MCP Apps views, written
 * against the core's seams and no SDK. It answers the view's handshake with the host context and
 * the capabilities the config declares, carries the view's requests into the bridge (which alone
 * decides whether they run), reports sizes, errors and teardown requests, and sends the view its
 * tool input, result and cancellation, never before the view said it was initialized (spec §
 * Sandbox proxy, 6). Behind the sandbox proxy it hands the proxy the view's HTML first.
 */

/** The tool call a view was made for: its host context's `toolInfo`. */
export interface ToolInfo {
  /** The JSON-RPC id of the `tools/call`. */
  readonly id?: string | number;
  /** The tool's definition (name, input schema, …) as the server listed it. */
  readonly tool: Readonly<Record<string, unknown>>;
}

export interface McpAppsAdapterOptions {
  /** The tool call each display shows, by display id. */
  readonly toolInfo?: (displayId: string) => ToolInfo | undefined;
  /** How long `teardown` waits for the view's answer, ms (default 3000). */
  readonly teardownTimeoutMs?: number;
}

/** A tool's result as MCP carries it (`CallToolResult`): content, structured content, `_meta`. */
export type ToolResult = Readonly<Record<string, unknown>>;

/** What a host drives on an MCP Apps view, besides the framework's own controls. */
export interface McpAppConnection extends AdapterConnection {
  /** The tool's arguments so far, while the agent writes them (dropped once the whole went). */
  sendToolInputPartial(args: Readonly<Record<string, unknown>>): void;
  /** The tool's whole arguments, once. */
  sendToolInput(args: Readonly<Record<string, unknown>>): void;
  /** The tool's result. */
  sendToolResult(result: ToolResult): void;
  /** The tool call was cancelled (by the person, an error, a policy). */
  sendToolCancelled(reason?: string): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Levels of `notifications/message` that are errors: they go to the host as `reportError`. */
const ERROR_LEVELS = new Set(["error", "critical", "alert", "emergency"]);
const DISPLAY_MODES = new Set(["inline", "fullscreen", "pip"]);
const STYLE_VARIABLES = new Set(MCP_APPS_STYLE_VARIABLES);

/**
 * The host context as a view may receive it: Porthole's fields as they are, its theme variables
 * cut to the names the standard defines (the official SDK refuses any other).
 */
export function viewHostContext(
  context: HostContext,
  toolInfo?: ToolInfo,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && key !== "styles") {
      out[key] = value;
    }
  }
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (STYLE_VARIABLES.has(name) && typeof value === "string") {
      variables[name] = value;
    }
  }
  out.styles = { variables };
  if (toolInfo !== undefined) {
    out.toolInfo = toolInfo;
  }
  return out;
}

/** Whether the host page has a live user gesture (a gesture in a frame activates its ancestors). */
function hostActivation(): boolean | undefined {
  const activation = (globalThis as { navigator?: { userActivation?: { isActive: boolean } } })
    .navigator?.userActivation;
  return activation === undefined ? undefined : activation.isActive;
}

function connect(session: AdapterSession, options: McpAppsAdapterOptions): McpAppConnection {
  const { transport, bridge } = session;
  let closed = false;
  let initialized = false;
  let inputSent = false;
  let resourceSent = false;
  /** What the host said before the view was initialized: sent, in order, once it is. */
  let queue: JsonRpcMessage[] = [];
  const pending = new Map<JsonRpcId, () => void>();
  let nextId = 1;

  const send = (message: JsonRpcMessage): void => {
    if (!closed) {
      transport.send(message);
    }
  };
  const notify = (method: string, params: Readonly<Record<string, unknown>>): void => {
    const message: JsonRpcMessage = { jsonrpc: "2.0", method, params };
    if (initialized) {
      send(message);
    } else {
      queue.push(message);
    }
  };
  const answer = (id: JsonRpcId, result: unknown): void => send({ jsonrpc: "2.0", id, result });
  // Live data (P079): reads, subscriptions and the host's updates, through the bridge.
  const live = liveData(bridge, (uri) => notify(MCP_APPS_METHODS.resourceUpdated, { uri }), {
    userActivated: hostActivation,
  });
  const refuse = (id: JsonRpcId, code: number, message: string): void =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  const hostCapabilities = (): Record<string, unknown> => {
    const declared = (name: CapabilityName) => bridge.declared(name);
    const { config } = session.compiled;
    const connectDomains = egressOrigins(config, "connect");
    const resourceDomains = [
      ...new Set(
        (["script", "style", "img", "font", "media"] as const).flatMap((kind) =>
          egressOrigins(config, kind),
        ),
      ),
    ];
    return {
      logging: {},
      ...(declared("openLink") ? { openLinks: {} } : {}),
      ...(declared("downloadFile") ? { downloadFile: {} } : {}),
      ...(declared("callTool") ? { serverTools: {} } : {}),
      ...(declared("readData")
        ? { serverResources: declared("subscribeData") ? { subscribe: true } : {} }
        : {}),
      ...(declared("sendPrompt") ? { message: { text: {} } } : {}),
      ...(declared("setModelContext") ? { updateModelContext: MODEL_CONTEXT_OFFERED } : {}),
      sandbox: {
        csp: {
          ...(connectDomains.length > 0 ? { connectDomains } : {}),
          ...(resourceDomains.length > 0 ? { resourceDomains } : {}),
        },
      },
    };
  };

  /** Runs a capability through the bridge and answers the request with what it gives. */
  async function call(
    request: JsonRpcRequest,
    capability: CapabilityName,
    args: unknown,
    result: (value: unknown) => unknown,
  ): Promise<void> {
    const userActivated = hostActivation();
    let outcome: CallOutcome<unknown>;
    try {
      outcome = await bridge.call(
        capability,
        args,
        userActivated === undefined ? undefined : { userActivated },
      );
    } catch {
      refuse(request.id, JSON_RPC_ERRORS.internal, `${request.method} failed`);
      return;
    }
    reply(request, capability, outcome, result);
  }

  /** Answers a request with a capability's outcome. */
  function reply(
    request: JsonRpcRequest,
    capability: CapabilityName,
    outcome: CallOutcome<unknown>,
    result: (value: unknown) => unknown,
  ): void {
    if (outcome.ok) {
      answer(request.id, result(outcome.value));
    } else if (outcome.refusal === "not-declared") {
      refuse(request.id, JSON_RPC_ERRORS.methodNotFound, `${request.method} isn't offered here`);
    } else {
      // The spec's "implementation-defined" error for a refused request, with why in its data
      // (`{ code, message }`, P080).
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32_000,
          message: `${request.method} refused (${outcome.refusal})`,
          data: reasonFor(capability, outcome),
        },
      });
    }
  }

  /** `{}` when a host function did it, `{ isError: true }` when it said it couldn't. */
  const done = (value: unknown): Record<string, unknown> =>
    value === false ? { isError: true } : {};

  async function onRequest(request: JsonRpcRequest): Promise<void> {
    const params = request.params ?? {};
    const invalid = (what: string) =>
      refuse(request.id, JSON_RPC_ERRORS.invalidParams, `${request.method}: ${what}`);
    switch (request.method) {
      case MCP_APPS_METHODS.initialize:
        answer(request.id, {
          protocolVersion: MCP_APPS_PROTOCOL_VERSION,
          hostInfo: session.hostInfo,
          hostCapabilities: hostCapabilities(),
          hostContext: viewHostContext(
            session.hostContext(),
            options.toolInfo?.(session.display.id),
          ),
        });
        return;
      case "ping":
        answer(request.id, {});
        return;
      case MCP_APPS_METHODS.message: {
        // Its text blocks, in order (the spec's examples send one), read bounded (P095).
        const content = params.content;
        const text =
          params.role === "user"
            ? messageText(
                Array.isArray(content) ? content : [content],
                "\n\n",
                session.compiled.config.limits.maxPromptChars,
              )
            : null;
        if (text === null) {
          invalid('needs role "user" and text content');
          return;
        }
        await call(request, "sendPrompt", { text }, done);
        return;
      }
      case MCP_APPS_METHODS.openLink:
        if (typeof params.url !== "string") {
          invalid("needs a url");
          return;
        }
        await call(request, "openLink", { url: params.url }, done);
        return;
      case MCP_APPS_METHODS.downloadFile:
        if (!Array.isArray(params.contents)) {
          invalid("needs contents");
          return;
        }
        await call(request, "downloadFile", { contents: params.contents }, done);
        return;
      case MCP_APPS_METHODS.callTool:
        if (
          typeof params.name !== "string" ||
          (params.arguments !== undefined && !isRecord(params.arguments))
        ) {
          invalid("needs a tool name and object arguments");
          return;
        }
        await call(
          request,
          "callTool",
          { name: params.name, arguments: params.arguments ?? {} },
          (value) => (isRecord(value) ? value : { content: [] }),
        );
        return;
      case MCP_APPS_METHODS.readResource:
        if (typeof params.uri !== "string") {
          invalid("needs a uri");
          return;
        }
        reply(request, "readData", await live.read(params.uri), (value) =>
          isRecord(value) ? value : { contents: [] },
        );
        return;
      case MCP_APPS_METHODS.subscribeResource:
      case MCP_APPS_METHODS.unsubscribeResource:
        if (!bridge.declared("subscribeData")) {
          refuse(
            request.id,
            JSON_RPC_ERRORS.methodNotFound,
            `${request.method} isn't offered here`,
          );
          return;
        }
        if (typeof params.uri !== "string") {
          invalid("needs a uri");
          return;
        }
        if (request.method === MCP_APPS_METHODS.unsubscribeResource) {
          live.unsubscribe(params.uri);
          answer(request.id, {});
          return;
        }
        reply(request, "subscribeData", await live.subscribe(params.uri), () => ({}));
        return;
      case MCP_APPS_METHODS.updateModelContext:
        if (
          (params.content !== undefined && !Array.isArray(params.content)) ||
          (params.structuredContent !== undefined && !isRecord(params.structuredContent))
        ) {
          invalid("content is a list, structuredContent an object");
          return;
        }
        await call(
          request,
          "setModelContext",
          {
            ...(params.content === undefined ? {} : { content: params.content }),
            ...(params.structuredContent === undefined
              ? {}
              : { structuredContent: params.structuredContent }),
          },
          () => ({}),
        );
        return;
      case COPY_TEXT_METHOD:
        // Porthole's own request (the standard has no clipboard request): the host copies, and
        // shows the person what (P052).
        if (typeof params.text !== "string") {
          invalid("needs text");
          return;
        }
        await call(request, "copyText", { text: params.text }, done);
        return;
      case MCP_APPS_METHODS.requestDisplayMode: {
        if (typeof params.mode !== "string" || !DISPLAY_MODES.has(params.mode)) {
          invalid("needs a display mode");
          return;
        }
        // Changing how a display is shown is the host's own layout: the view keeps its mode, and
        // the answer says so (spec: return the current mode when the request isn't granted).
        answer(request.id, { mode: session.hostContext().displayMode });
        return;
      }
      default:
        refuse(request.id, JSON_RPC_ERRORS.methodNotFound, `${request.method} isn't offered here`);
    }
  }

  function onNotification(method: string, params: Readonly<Record<string, unknown>>): void {
    switch (method) {
      case MCP_APPS_METHODS.sandboxProxyReady:
        // Behind the sandbox proxy: it takes the view's HTML once, then becomes the view (P026).
        if (!resourceSent && session.document !== undefined) {
          resourceSent = true;
          send({
            jsonrpc: "2.0",
            method: MCP_APPS_METHODS.sandboxResourceReady,
            params: { html: session.document },
          });
        }
        return;
      case MCP_APPS_METHODS.initialized:
        if (!initialized) {
          initialized = true;
          const waiting = queue;
          queue = [];
          for (const message of waiting) {
            send(message);
          }
          session.emit({ type: "initialized" });
        }
        return;
      case MCP_APPS_METHODS.sizeChanged: {
        const { height, width } = params;
        const size = (value: unknown): value is number =>
          typeof value === "number" && Number.isFinite(value) && value >= 0;
        if (size(height)) {
          void bridge.call("resize", { height, ...(size(width) ? { width } : {}) });
        }
        return;
      }
      case MCP_APPS_METHODS.log:
        // What the view said, as it came (S05, P095): the bridge reads it only within
        // reportError's declaration and rate, into bounded text, and nothing in it throws here.
        if (typeof params.level === "string" && ERROR_LEVELS.has(params.level)) {
          void bridge.call("reportError", { message: params.data });
        }
        return;
      case NAVIGATION_BLOCKED_METHOD:
        // The shell, hardening the view's frame, stopped a navigation (P080): an error report,
        // with its address.
        void bridge.call("reportError", { navigationBlocked: params.url });
        return;
      case MCP_APPS_METHODS.requestTeardown:
        session.emit({ type: "teardown-requested" });
        return;
      default:
    }
  }

  const unlisten = transport.listen((raw) => {
    const message = parseJsonRpc(raw);
    if (message === null || closed) {
      return;
    }
    if (!("method" in message)) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      waiting?.();
      return;
    }
    if ("id" in message) {
      void onRequest(message);
    } else {
      onNotification(message.method, message.params ?? {});
    }
  });

  return {
    hostContextChanged(context) {
      if (initialized) {
        send({
          jsonrpc: "2.0",
          method: MCP_APPS_METHODS.hostContextChanged,
          params: viewHostContext(context),
        });
      }
    },
    teardown() {
      if (closed || !initialized) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const id = nextId++;
        const finish = () => {
          clearTimeout(timer);
          pending.delete(id);
          resolve();
        };
        const timer = setTimeout(finish, options.teardownTimeoutMs ?? 3_000);
        pending.set(id, finish);
        send({ jsonrpc: "2.0", id, method: MCP_APPS_METHODS.resourceTeardown, params: {} });
      });
    },
    close() {
      closed = true;
      live.close();
      unlisten();
      queue = [];
      for (const waiting of pending.values()) {
        waiting();
      }
    },
    sendToolInputPartial(args) {
      if (inputSent) {
        return;
      }
      if (!initialized) {
        // Only the latest draft matters to a view that hasn't seen any.
        queue = queue.filter(
          (message) =>
            !("method" in message) || message.method !== MCP_APPS_METHODS.toolInputPartial,
        );
      }
      notify(MCP_APPS_METHODS.toolInputPartial, { arguments: args });
    },
    sendToolInput(args) {
      if (inputSent) {
        return;
      }
      inputSent = true;
      queue = queue.filter(
        (message) => !("method" in message) || message.method !== MCP_APPS_METHODS.toolInputPartial,
      );
      notify(MCP_APPS_METHODS.toolInput, { arguments: args });
    },
    sendToolResult(result) {
      notify(MCP_APPS_METHODS.toolResult, result);
    },
    sendToolCancelled(reason) {
      notify(MCP_APPS_METHODS.toolCancelled, reason === undefined ? {} : { reason });
    },
  };
}

/** The MCP Apps adapter: pass it as `HostOptions.adapter` with the `mcpApp` preset. */
export function mcpAppsAdapter(
  options: McpAppsAdapterOptions = {},
): ProtocolAdapter<McpAppConnection> {
  return { name: "mcp-apps", connect: (session) => connect(session, options) };
}
