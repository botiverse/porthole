/**
 * A host page for MCP Apps views on Porthole's own adapter, run in the browser (the harness serves
 * it, and the sources it imports, stripped of types). It frames a view the way a mount does, in an
 * opaque frame hardened by the shell or behind the sandbox proxy on a located origin, and connects
 * `mcpAppsAdapter` to it through a postMessage transport bound to the frame's window and origin.
 * The bridge here is a recording stand-in for the core's: it lets every declared call through
 * (gates are the core's to prove) and records what reached it, with the host page's activation.
 */
import type { CallOutcome, HostFunctionBridge } from "../../src/bridge/types.ts";
import type { CapabilityName } from "../../src/config/capabilities.ts";
import {
  compile,
  presets,
  resolveTheme,
  type ColorScheme,
  type EgressConfig,
} from "../../src/index.ts";
import { mcpAppsAdapter, type McpAppConnection, type ToolInfo } from "../../src/mcp/index.ts";
import type { HostContext } from "../../src/protocol/mcp-apps.ts";
import type { JsonRpcMessage } from "../../src/protocol/jsonrpc.ts";

export interface MountSpec {
  readonly html: string;
  readonly egress?: EgressConfig;
  /** Behind the sandbox proxy: where it was located, and the content origins' frame source. */
  readonly located?: {
    readonly url: string;
    readonly origin: string;
    readonly contentSource: string;
  };
  readonly toolInfo?: ToolInfo;
}

export interface Recorded {
  readonly capability: CapabilityName;
  readonly args: unknown;
  readonly userActivated: boolean | undefined;
}

type ToolOp = "sendToolInputPartial" | "sendToolInput" | "sendToolResult" | "sendToolCancelled";

interface Display {
  readonly connection: McpAppConnection;
  readonly calls: Recorded[];
  readonly events: string[];
  scheme: ColorScheme;
  context(): HostContext;
}

declare global {
  interface Window {
    /** The test's host functions (exposed by Playwright): the MCP server's tools, say. */
    portholeHandle?: (capability: string, args: unknown) => Promise<unknown>;
    mcpHost: typeof mcpHost;
  }
}

const displays: Display[] = [];

const mcpHost = {
  mount(spec: MountSpec): number {
    const index = displays.length;
    const config = presets.mcpApp({
      capabilities: {
        sendPrompt: {},
        openLink: {},
        callTool: {},
        readData: {},
        setModelContext: {},
        downloadFile: {},
      },
      ...(spec.egress === undefined ? {} : { egress: spec.egress }),
      ...(spec.located === undefined
        ? {}
        : { isolation: "domain" as const, contentOrigins: [spec.located.contentSource] }),
    });
    const compiled = compile(config);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", compiled.sandbox);
    frame.setAttribute("allow", compiled.allow);
    frame.setAttribute("referrerpolicy", compiled.referrerPolicy);
    frame.dataset.display = String(index);
    frame.style.cssText = "display:block;width:640px;height:200px;border:0";
    const origin = spec.located?.origin ?? "null";
    const listeners = new Set<(message: unknown) => void>();
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.contentWindow && event.origin === origin) {
        for (const listener of listeners) {
          listener(event.data);
        }
      }
    };
    window.addEventListener("message", onMessage);
    const transport = {
      send: (message: JsonRpcMessage) =>
        frame.contentWindow?.postMessage(message, spec.located === undefined ? "*" : origin),
      listen: (listener: (message: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => window.removeEventListener("message", onMessage),
    };
    const display: Display = {
      calls: [],
      events: [],
      scheme: "light",
      context: () => ({
        theme: display.scheme,
        styles: { variables: resolveTheme(config.theme, display.scheme) },
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        containerDimensions: { maxHeight: config.limits.maxHeightPx },
        platform: "web",
        locale: "en-US",
      }),
      connection: undefined as unknown as McpAppConnection,
    };
    const bridge: HostFunctionBridge = {
      declared: (name) => config.capabilities[name] !== undefined,
      roster: () => ({}),
      async call(capability, args, options) {
        display.calls.push({ capability, args, userActivated: options?.userActivated });
        if (config.capabilities[capability] === undefined) {
          return { ok: false, refusal: "not-declared" };
        }
        if (capability === "resize") {
          const { height } = args as { height: number };
          frame.style.height = `${Math.min(Math.max(height, 24), config.limits.maxHeightPx)}px`;
          return { ok: true, value: undefined } as CallOutcome<never>;
        }
        const value = await (window.portholeHandle?.(capability, args) ?? Promise.resolve(true));
        return { ok: true, value } as CallOutcome<never>;
      },
    };
    (display as { connection: McpAppConnection }).connection = mcpAppsAdapter({
      toolInfo: () => spec.toolInfo,
    }).connect({
      display: { id: `display-${index}`, title: "An MCP App" },
      compiled,
      transport,
      bridge,
      hostInfo: { name: "porthole-reference", version: "0" },
      hostContext: () => display.context(),
      emit: (event) => display.events.push(event.type),
      document: spec.html,
    });
    if (spec.located === undefined) {
      frame.srcdoc = compiled.shellDocument({ origins: [location.origin], document: spec.html });
    } else {
      frame.src = spec.located.url;
    }
    document.getElementById("displays")?.append(frame);
    displays.push(display);
    return index;
  },

  send(index: number, op: ToolOp, value: unknown): void {
    const { connection } = displays[index]!;
    if (op === "sendToolCancelled") {
      connection.sendToolCancelled(value as string | undefined);
    } else {
      connection[op](value as Readonly<Record<string, unknown>>);
    }
  },

  setTheme(index: number, scheme: ColorScheme): void {
    const display = displays[index]!;
    display.scheme = scheme;
    display.connection.hostContextChanged(display.context());
  },

  teardown: (index: number): Promise<void> => displays[index]!.connection.teardown(),
  calls: (index: number): readonly Recorded[] => displays[index]!.calls,
  events: (index: number): readonly string[] => displays[index]!.events,
};

window.mcpHost = mcpHost;
