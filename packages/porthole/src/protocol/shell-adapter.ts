import type { CapabilityName } from "../config/capabilities.ts";
import type { CallOutcome } from "../bridge/types.ts";
import type { AdapterSession, ProtocolAdapter, ShellConnection } from "./adapter.ts";
import {
  JSON_RPC_ERRORS,
  parseJsonRpc,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.ts";
import { reasonFor, type RefusalReason } from "../bridge/refusal.ts";
import {
  COPY_TEXT_METHOD,
  NAVIGATING_METHOD,
  NAVIGATION_BLOCKED_METHOD,
  MCP_APPS_METHODS as M,
  MCP_APPS_PROTOCOL_VERSION,
  type HostContext,
} from "./mcp-apps.ts";
import { liveData } from "./live-data.ts";
import { runtimeCalls } from "./runtime-calls.ts";
import {
  RUNTIME_CALL_METHOD,
  RUNTIME_EXPERIMENTAL_KEY,
  RUNTIME_UNWATCH_METHOD,
} from "../runtime/contract.ts";

/**
 * The core's adapter: the host side of the MCP Apps subset the shell speaks, which content using
 * the official App SDK speaks too. Every message is checked before use; every power goes through
 * the bridge. Content goes as `tool-input-partial` while it is written and `tool-input` once,
 * after the view has initialized.
 */

const LOG_ERRORS = new Set(["error", "critical", "alert", "emergency"]);

/** Requests that are capability calls, and how their params become the capability's args. */
const REQUESTS: Readonly<
  Record<string, { capability: CapabilityName; args: (params: Record<string, unknown>) => unknown }>
> = {
  [M.message]: {
    capability: "sendPrompt",
    args: (params) => ({
      text: Array.isArray(params.content)
        ? params.content
            .map((part: unknown) => {
              const block = part as { type?: unknown; text?: unknown } | null;
              return block !== null &&
                typeof block === "object" &&
                block.type === "text" &&
                typeof block.text === "string"
                ? block.text
                : "";
            })
            .join("")
        : undefined,
    }),
  },
  [M.openLink]: { capability: "openLink", args: (params) => ({ url: params.url }) },
  [COPY_TEXT_METHOD]: { capability: "copyText", args: (params) => ({ text: params.text }) },
  [M.downloadFile]: {
    capability: "downloadFile",
    args: (params) => ({ contents: params.contents }),
  },
  [M.callTool]: {
    capability: "callTool",
    args: (params) => ({ name: params.name, arguments: params.arguments }),
  },
  [M.updateModelContext]: {
    capability: "setModelContext",
    args: (params) => ({ content: params.content, structuredContent: params.structuredContent }),
  },
};

/** What a capability's outcome looks like to the view. */
function answer(
  capability: CapabilityName,
  outcome: CallOutcome<unknown>,
): { result: unknown } | { error: { code: number; message: string; data?: RefusalReason } } {
  const flagged =
    capability === "sendPrompt" ||
    capability === "openLink" ||
    capability === "downloadFile" ||
    capability === "copyText";
  if (!outcome.ok) {
    return flagged
      ? { result: { isError: true } }
      : {
          // Why, in the error's data (`{ code, message }`, P080).
          error: {
            code: -32000,
            message: `Refused (${outcome.refusal})`,
            data: reasonFor(capability, outcome),
          },
        };
  }
  if (flagged) {
    return { result: outcome.value === true ? {} : { isError: true } };
  }
  return { result: outcome.value ?? {} };
}

/** What the host offers, from the declared capabilities (MCP Apps `hostCapabilities`). */
export function hostCapabilities(
  declared: (name: CapabilityName) => boolean,
): Record<string, object> {
  const offered: Record<string, object> = {};
  if (declared("openLink")) {
    offered.openLinks = {};
  }
  if (declared("sendPrompt")) {
    offered.message = { text: {} };
  }
  if (declared("downloadFile")) {
    offered.downloadFile = {};
  }
  if (declared("callTool")) {
    offered.serverTools = {};
  }
  if (declared("readData")) {
    // MCP's own flag for resources/subscribe (P079), in the field that mirrors MCP's capability.
    offered.serverResources = declared("subscribeData") ? { subscribe: true } : {};
  }
  if (declared("setModelContext")) {
    offered.updateModelContext = { text: {} };
  }
  if (declared("reportError")) {
    offered.logging = {};
  }
  return offered;
}

export const shellAdapter: ProtocolAdapter<ShellConnection> = {
  name: "porthole-shell",
  connect(session: AdapterSession): ShellConnection {
    const { transport, bridge } = session;
    let initialized = false;
    let closed = false;
    let drafted: string | null = null;
    let content: { html: string; partial: boolean } | null = null;
    let sentWhole = false;
    let nextId = 1;
    const pending = new Map<JsonRpcId, (response: JsonRpcResponse) => void>();
    const respond = (
      id: JsonRpcId,
      body: { result: unknown } | { error: { code: number; message: string } },
    ) => transport.send({ jsonrpc: "2.0", id, ...body });
    const notify = (method: string, params: Record<string, unknown>) =>
      transport.send({ jsonrpc: "2.0", method, params });

    // Live data (P079): reads, subscriptions and the host's updates, through the bridge.
    const live = liveData(bridge, (uri) => notify(M.resourceUpdated, { uri }));
    // The capability runtime (P085), where the config has one: its calls and watches.
    const runtime = session.compiled.config.runtime;
    const calls = runtimeCalls(bridge, notify);

    const flush = () => {
      if (!initialized || closed || content === null || sentWhole) {
        return;
      }
      if (content.partial) {
        if (drafted !== content.html) {
          drafted = content.html;
          notify(M.toolInputPartial, { arguments: { html: content.html } });
        }
        return;
      }
      sentWhole = true;
      notify(M.toolInput, { arguments: { html: content.html } });
    };

    const onRequest = async (request: JsonRpcRequest) => {
      const params = request.params ?? {};
      if (request.method === M.initialize) {
        respond(request.id, {
          result: {
            protocolVersion: MCP_APPS_PROTOCOL_VERSION,
            hostInfo: session.hostInfo,
            hostCapabilities: {
              ...hostCapabilities((name) => bridge.declared(name)),
              // What this display's page may `use`, in MCP Apps' extension point (P085).
              ...(runtime === undefined
                ? {}
                : {
                    experimental: {
                      [RUNTIME_EXPERIMENTAL_KEY]: {
                        version: runtime,
                        capabilities: bridge.roster(),
                      },
                    },
                  }),
            },
            hostContext: session.hostContext(),
          },
        });
        return;
      }
      if (request.method === "ping") {
        respond(request.id, { result: {} });
        return;
      }
      if (request.method === M.requestDisplayMode) {
        respond(request.id, { result: { mode: "inline" } });
        return;
      }
      if (request.method === M.readResource) {
        const outcome = await live.read(params.uri);
        if (!closed) {
          respond(request.id, answer("readData", outcome));
        }
        return;
      }
      if (request.method === M.subscribeResource || request.method === M.unsubscribeResource) {
        if (!bridge.declared("subscribeData")) {
          respond(request.id, {
            error: {
              code: JSON_RPC_ERRORS.methodNotFound,
              message: `${request.method} isn't offered here`,
            },
          });
          return;
        }
        if (request.method === M.subscribeResource) {
          const outcome = await live.subscribe(params.uri);
          if (!closed) {
            respond(request.id, outcome.ok ? { result: {} } : answer("subscribeData", outcome));
          }
        } else {
          live.unsubscribe(params.uri);
          respond(request.id, { result: {} });
        }
        return;
      }
      if (request.method === RUNTIME_CALL_METHOD && runtime !== undefined) {
        const answered = await calls.call(params);
        if (!closed) {
          respond(request.id, answered);
        }
        return;
      }
      const mapped = REQUESTS[request.method];
      if (mapped === undefined) {
        respond(request.id, {
          error: {
            code: JSON_RPC_ERRORS.methodNotFound,
            message: `${request.method} isn't offered here`,
          },
        });
        return;
      }
      const outcome = await bridge.call(mapped.capability, mapped.args(params));
      if (!closed) {
        respond(request.id, answer(mapped.capability, outcome));
      }
    };

    const onNotification = (method: string, params: Record<string, unknown>) => {
      switch (method) {
        case M.initialized:
          if (!initialized) {
            initialized = true;
            session.emit({ type: "initialized" });
            flush();
          }
          return;
        case M.sizeChanged:
          void bridge.call("resize", { height: params.height, width: params.width });
          return;
        case M.log:
          if (LOG_ERRORS.has(String(params.level))) {
            const data = params.data;
            void bridge.call("reportError", {
              message:
                typeof data === "string" ? data : JSON.stringify(data ?? null).slice(0, 2_000),
            });
          }
          return;
        case NAVIGATION_BLOCKED_METHOD:
          // The shell stopped a navigation (P080): an error report, with its address.
          void bridge.call("reportError", { navigationBlocked: params.url });
          return;
        case RUNTIME_UNWATCH_METHOD:
          calls.unwatch(params);
          return;
        case NAVIGATING_METHOD:
          // Another page of the set opens in the frame (P084): its next load is that page.
          session.emit({ type: "navigating" });
          return;
        case M.requestTeardown:
          session.emit({ type: "teardown-requested" });
          return;
        default:
          return;
      }
    };

    const stop = transport.listen((raw) => {
      const message = parseJsonRpc(raw);
      if (message === null || closed) {
        return;
      }
      if ("method" in message) {
        if ("id" in message) {
          void onRequest(message);
        } else {
          onNotification(message.method, message.params ?? {});
        }
        return;
      }
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });

    return {
      setContent(html: string, options?: { readonly partial?: boolean }) {
        if (sentWhole) {
          return;
        }
        content = { html, partial: options?.partial === true };
        flush();
      },
      hostContextChanged(context: HostContext) {
        if (initialized && !closed) {
          notify(M.hostContextChanged, { ...context });
        }
      },
      teardown() {
        if (!initialized || closed) {
          return Promise.resolve();
        }
        const id = `teardown-${nextId++}`;
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve();
          }, 500);
          pending.set(id, () => {
            clearTimeout(timer);
            resolve();
          });
          transport.send({ jsonrpc: "2.0", id, method: M.resourceTeardown, params: {} });
        });
      },
      close() {
        closed = true;
        stop();
        pending.clear();
        live.close();
        calls.close();
      },
    };
  },
};
