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
import { MCP_APPS_METHODS as M, MCP_APPS_PROTOCOL_VERSION, type HostContext } from "./mcp-apps.ts";

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
  [M.downloadFile]: {
    capability: "downloadFile",
    args: (params) => ({ contents: params.contents }),
  },
  [M.callTool]: {
    capability: "callTool",
    args: (params) => ({ name: params.name, arguments: params.arguments }),
  },
  [M.readResource]: { capability: "readData", args: (params) => ({ uri: params.uri }) },
  [M.updateModelContext]: {
    capability: "setModelContext",
    args: (params) => ({ content: params.content, structuredContent: params.structuredContent }),
  },
};

/** What a capability's outcome looks like to the view. */
function answer(
  capability: CapabilityName,
  outcome: CallOutcome<unknown>,
): { result: unknown } | { error: { code: number; message: string } } {
  const flagged =
    capability === "sendPrompt" || capability === "openLink" || capability === "downloadFile";
  if (!outcome.ok) {
    return flagged
      ? { result: { isError: true } }
      : { error: { code: -32000, message: `Refused (${outcome.refusal})` } };
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
    offered.serverResources = {};
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
            hostCapabilities: hostCapabilities((name) => bridge.declared(name)),
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
      },
    };
  },
};
