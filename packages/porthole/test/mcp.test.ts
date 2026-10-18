import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { CallOutcome, HostFunctionBridge } from "../src/bridge/types.ts";
import type { CapabilityName } from "../src/config/capabilities.ts";
import { compile, presets, resolveTheme, type PresetOptions } from "../src/index.ts";
import {
  MCP_APPS_STYLE_VARIABLES,
  mcpAppsAdapter,
  readViewResource,
  viewEgress,
  type McpAppsAdapterOptions,
} from "../src/mcp/index.ts";
import type { AdapterEvent } from "../src/protocol/adapter.ts";
import type { HostContext } from "../src/protocol/mcp-apps.ts";

type Message = Record<string, unknown> & {
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
};

function setup(
  options: {
    preset?: PresetOptions;
    outcome?: (capability: CapabilityName, args: unknown) => CallOutcome<unknown>;
    document?: string;
    adapter?: McpAppsAdapterOptions;
  } = {},
) {
  const config = presets.mcpApp(
    options.preset ?? {
      capabilities: {
        sendPrompt: {},
        openLink: {},
        callTool: {},
        readData: {},
        setModelContext: {},
        downloadFile: {},
      },
    },
  );
  const sent: Message[] = [];
  let listener: ((message: unknown) => void) | null = null;
  const calls: { capability: CapabilityName; args: unknown; options: unknown }[] = [];
  const events: AdapterEvent[] = [];
  const bridge: HostFunctionBridge = {
    roster: () => ({}),
    declared: (name) => config.capabilities[name] !== undefined,
    call: async (capability, args, callOptions) => {
      calls.push({ capability, args, options: callOptions });
      return (options.outcome?.(capability, args) ?? { ok: true, value: true }) as never;
    },
  };
  const context: HostContext = {
    theme: "light",
    styles: { variables: resolveTheme(config.theme, "light") },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    locale: "en-US",
  };
  const connection = mcpAppsAdapter(options.adapter).connect({
    display: { id: "d1", title: "A view" },
    compiled: compile(config),
    transport: {
      send: (message) => sent.push(message as Message),
      listen: (each) => {
        listener = each;
        return () => {
          listener = null;
        };
      },
      close: () => {},
    },
    bridge,
    hostInfo: { name: "test-host", version: "1" },
    hostContext: () => context,
    emit: (event) => events.push(event),
    ...(options.document === undefined ? {} : { document: options.document }),
  });
  const view = (message: Record<string, unknown>) => listener?.({ jsonrpc: "2.0", ...message });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const answerTo = (id: number) =>
    sent.find((message) => message.id === id && message.method === undefined);
  const resultOf = (id: number): unknown => answerTo(id)?.result;
  const errorCode = (id: number) => (answerTo(id)?.error as { code?: number } | undefined)?.code;
  const initialize = async () => {
    view({
      id: 1,
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        appInfo: { name: "v", version: "1" },
        appCapabilities: {},
      },
    });
    view({ method: "ui/notifications/initialized" });
    await settle();
  };
  return {
    sent,
    calls,
    events,
    connection,
    view,
    settle,
    answerTo,
    resultOf,
    errorCode,
    initialize,
    isListening: () => listener !== null,
  };
}

describe("the handshake", () => {
  it("answers ui/initialize with the protocol version, host, declared capabilities and context", async () => {
    const t = setup({
      adapter: {
        toolInfo: (id) => (id === "d1" ? { id: 7, tool: { name: "get-time" } } : undefined),
      },
    });
    t.view({ id: 1, method: "ui/initialize", params: {} });
    await t.settle();
    const result = t.answerTo(1)?.result as Record<string, Record<string, unknown>>;
    expect(result.protocolVersion).toBe("2026-01-26");
    expect(result.hostInfo).toEqual({ name: "test-host", version: "1" });
    expect(result.hostCapabilities).toEqual({
      logging: {},
      openLinks: {},
      downloadFile: {},
      serverTools: {},
      serverResources: {},
      message: { text: {} },
      updateModelContext: { text: {}, structuredContent: {} },
      sandbox: { csp: {} },
    });
    expect(result.hostContext?.toolInfo).toEqual({ id: 7, tool: { name: "get-time" } });
    expect(result.hostContext?.theme).toBe("light");
    expect(result.hostContext?.locale).toBe("en-US");
  });

  it("sends a view only the standard style variables (the SDK refuses any other)", async () => {
    const t = setup();
    t.view({ id: 1, method: "ui/initialize", params: {} });
    await t.settle();
    const variables = (
      t.resultOf(1) as {
        hostContext: { styles: { variables: Record<string, string> } };
      }
    ).hostContext.styles.variables;
    expect(Object.keys(variables).length).toBeGreaterThan(20);
    expect(Object.keys(variables).every((name) => MCP_APPS_STYLE_VARIABLES.includes(name))).toBe(
      true,
    );
    expect(variables["--color-accent"]).toBeUndefined();
  });

  it("offers only what the config declares, and the egress it opens", async () => {
    const t = setup({
      preset: {
        egress: { connect: ["https://api.example.org"], img: ["https://img.example.org"] },
      },
    });
    t.view({ id: 1, method: "ui/initialize", params: {} });
    await t.settle();
    expect((t.resultOf(1) as { hostCapabilities: unknown }).hostCapabilities).toEqual({
      logging: {},
      sandbox: {
        csp: {
          connectDomains: ["https://api.example.org"],
          resourceDomains: ["https://img.example.org"],
        },
      },
    });
  });

  it("sends nothing before the view is initialized, then all of it, in order", async () => {
    const t = setup();
    t.connection.sendToolInputPartial({ code: "a" });
    t.connection.sendToolInputPartial({ code: "ab" });
    t.connection.hostContextChanged({
      theme: "dark",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
    });
    t.connection.sendToolInput({ code: "abc" });
    t.connection.sendToolInputPartial({ code: "late" });
    t.connection.sendToolInput({ code: "again" });
    t.connection.sendToolResult({ content: [{ type: "text", text: "done" }] });
    expect(t.sent).toEqual([]);
    await t.initialize();
    expect(
      t.sent
        .filter((message) => message.method !== undefined)
        .map((message) => [message.method, message.params]),
    ).toEqual([
      ["ui/notifications/tool-input", { arguments: { code: "abc" } }],
      ["ui/notifications/tool-result", { content: [{ type: "text", text: "done" }] }],
    ]);
    expect(t.events).toEqual([{ type: "initialized" }]);
  });

  it("keeps only the latest draft for a view that hasn't seen any, and streams them after", async () => {
    const t = setup();
    t.connection.sendToolInputPartial({ code: "a" });
    t.connection.sendToolInputPartial({ code: "ab" });
    await t.initialize();
    t.connection.sendToolInputPartial({ code: "abc" });
    t.connection.sendToolCancelled("the person stopped it");
    expect(
      t.sent
        .filter((message) => message.method !== undefined)
        .map((message) => [message.method, message.params]),
    ).toEqual([
      ["ui/notifications/tool-input-partial", { arguments: { code: "ab" } }],
      ["ui/notifications/tool-input-partial", { arguments: { code: "abc" } }],
      ["ui/notifications/tool-cancelled", { reason: "the person stopped it" }],
    ]);
  });

  it("tells an initialized view of context changes, its variables cut to the standard", async () => {
    const t = setup();
    await t.initialize();
    t.connection.hostContextChanged({
      theme: "dark",
      styles: { variables: { "--color-text-primary": "#fff", "--color-accent": "#09f" } },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
    });
    expect(t.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: {
        theme: "dark",
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        styles: { variables: { "--color-text-primary": "#fff" } },
      },
    });
  });
});

describe("requests go through the bridge", () => {
  it("maps ui/message to sendPrompt, with the host page's activation", async () => {
    const t = setup();
    vi.stubGlobal("navigator", { userActivation: { isActive: true } });
    try {
      t.view({
        id: 5,
        method: "ui/message",
        params: {
          role: "user",
          content: [
            { type: "text", text: "Hi" },
            { type: "text", text: "there" },
          ],
        },
      });
      await t.settle();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(t.calls).toEqual([
      { capability: "sendPrompt", args: { text: "Hi\n\nthere" }, options: { userActivated: true } },
    ]);
    expect(t.answerTo(5)?.result).toEqual({});
  });

  it("accepts the spec's single content block, and refuses a message without text", async () => {
    const t = setup();
    t.view({
      id: 5,
      method: "ui/message",
      params: { role: "user", content: { type: "text", text: "one" } },
    });
    t.view({
      id: 6,
      method: "ui/message",
      params: { role: "user", content: [{ type: "image", data: "" }] },
    });
    await t.settle();
    expect(t.calls.map((call) => call.args)).toEqual([{ text: "one" }]);
    expect(t.errorCode(6)).toBe(-32602);
  });

  it("answers a refusal with an error, and a host function that couldn't with isError", async () => {
    const t = setup({
      outcome: (capability) =>
        capability === "openLink" ? { ok: false, refusal: "declined" } : { ok: true, value: false },
    });
    t.view({ id: 1, method: "ui/open-link", params: { url: "https://example.com" } });
    t.view({
      id: 2,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "x" }] },
    });
    await t.settle();
    expect(t.answerTo(1)?.error).toEqual({
      code: -32000,
      message: "ui/open-link refused (declined)",
      data: { code: "denied", message: "You didn't allow this." },
    });
    expect(t.answerTo(2)?.result).toEqual({ isError: true });
  });

  it("answers an undeclared capability as a method this host doesn't offer", async () => {
    const t = setup({ preset: {}, outcome: () => ({ ok: false, refusal: "not-declared" }) });
    t.view({ id: 1, method: "tools/call", params: { name: "x" } });
    await t.settle();
    expect(t.errorCode(1)).toBe(-32601);
  });

  it("carries tools/call, resources/read, model context and downloads", async () => {
    const result = {
      content: [{ type: "text", text: "12:00" }],
      structuredContent: { time: "12:00" },
    };
    const t = setup({
      outcome: (capability) =>
        capability === "callTool"
          ? { ok: true, value: result }
          : capability === "readData"
            ? { ok: true, value: { contents: [{ uri: "x://y", text: "z" }] } }
            : { ok: true, value: true },
    });
    t.view({ id: 1, method: "tools/call", params: { name: "get-time" } });
    t.view({ id: 2, method: "resources/read", params: { uri: "x://y" } });
    t.view({ id: 3, method: "ui/update-model-context", params: { structuredContent: { a: 1 } } });
    t.view({
      id: 4,
      method: "ui/download-file",
      params: { contents: [{ type: "resource", resource: { uri: "f", text: "t" } }] },
    });
    await t.settle();
    expect(t.calls.map((call) => [call.capability, call.args])).toEqual([
      ["callTool", { name: "get-time", arguments: {} }],
      ["readData", { uri: "x://y" }],
      ["setModelContext", { structuredContent: { a: 1 } }],
      ["downloadFile", { contents: [{ type: "resource", resource: { uri: "f", text: "t" } }] }],
    ]);
    expect(t.answerTo(1)?.result).toEqual(result);
    expect(t.answerTo(2)?.result).toEqual({ contents: [{ uri: "x://y", text: "z" }] });
    expect(t.answerTo(3)?.result).toEqual({});
    expect(t.answerTo(4)?.result).toEqual({});
  });

  it("carries MCP's resource subscriptions, and tells the view what changed (P079)", async () => {
    const t = setup({
      preset: { capabilities: { readData: {}, subscribeData: {} } },
      outcome: (capability) =>
        capability === "readData"
          ? { ok: true, value: { contents: [{ uri: "app://n", text: "1" }] } }
          : { ok: true, value: undefined },
    });
    await t.initialize();
    expect(t.resultOf(1)).toMatchObject({
      hostCapabilities: { serverResources: { subscribe: true } },
    });
    t.view({ id: 2, method: "resources/subscribe", params: { uri: "app://n" } });
    await t.settle();
    expect(t.answerTo(2)?.result).toEqual({});
    const subscribed = t.calls.find((call) => call.capability === "subscribeData");
    expect(subscribed?.args).toEqual({ uri: "app://n" });
    const { subscription } = (subscribed?.options ?? {}) as {
      subscription: { changed: (result?: unknown) => void; signal: AbortSignal };
    };
    subscription.changed();
    await t.settle();
    expect(
      t.sent.filter((message) => message.method === "notifications/resources/updated"),
    ).toEqual([
      { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "app://n" } },
    ]);
    t.view({ id: 3, method: "resources/unsubscribe", params: { uri: "app://n" } });
    await t.settle();
    expect(t.answerTo(3)?.result).toEqual({});
    expect(subscription.signal.aborted).toBe(true);
  });

  it("doesn't offer subscriptions where subscribeData isn't declared", async () => {
    const t = setup({ preset: { capabilities: { readData: {} } } });
    await t.initialize();
    expect(t.resultOf(1)).toMatchObject({ hostCapabilities: { serverResources: {} } });
    t.view({ id: 2, method: "resources/subscribe", params: { uri: "app://n" } });
    await t.settle();
    expect(t.errorCode(2)).toBe(-32601);
  });

  it("refuses malformed params without asking the bridge", async () => {
    const t = setup();
    t.view({ id: 1, method: "ui/open-link", params: { url: 3 } });
    t.view({ id: 2, method: "tools/call", params: { name: "x", arguments: [] } });
    t.view({ id: 3, method: "ui/update-model-context", params: { content: "text" } });
    await t.settle();
    expect(t.calls).toEqual([]);
    for (const id of [1, 2, 3]) {
      expect(t.errorCode(id)).toBe(-32602);
    }
  });

  it("keeps the view's display mode, answering with it", async () => {
    const t = setup();
    t.view({ id: 1, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
    await t.settle();
    expect(t.answerTo(1)?.result).toEqual({ mode: "inline" });
  });

  it("answers ping, refuses unknown methods, and drops what isn't JSON-RPC", async () => {
    const t = setup();
    t.view({ id: 1, method: "ping" });
    t.view({ id: 2, method: "sampling/createMessage", params: {} });
    t.view({ method: "something/else" });
    t.view({ id: 3, result: {} });
    await t.settle();
    expect(t.answerTo(1)?.result).toEqual({});
    expect(t.errorCode(2)).toBe(-32601);
    expect(t.sent).toHaveLength(2);
  });
});

describe("notifications from the view", () => {
  it("reports sizes and errors through the bridge, and nothing for other log levels", async () => {
    const t = setup();
    t.view({ method: "ui/notifications/size-changed", params: { width: 300, height: 120 } });
    t.view({ method: "ui/notifications/size-changed", params: { width: 300 } });
    t.view({
      method: "notifications/message",
      params: { level: "error", data: { reason: "boom" } },
    });
    t.view({ method: "notifications/message", params: { level: "info", data: "fine" } });
    await t.settle();
    expect(t.calls.map((call) => [call.capability, call.args])).toEqual([
      ["resize", { height: 120, width: 300 }],
      ["reportError", { message: '{"reason":"boom"}' }],
    ]);
  });

  it("carries a navigation the shell stopped into reportError, with its address (P080)", async () => {
    const t = setup();
    t.view({
      method: "porthole/navigation-blocked",
      params: { url: "https://elsewhere.example/?d=1" },
    });
    await t.settle();
    expect(t.calls.map((call) => [call.capability, call.args])).toEqual([
      ["reportError", { navigationBlocked: "https://elsewhere.example/?d=1" }],
    ]);
  });

  it("answers a refused read with why, in the error's data (P080)", async () => {
    const t = setup({
      outcome: () => ({
        ok: false,
        refusal: "failed",
        reason: { code: "not_allowed", message: "Only issues are shown here." },
      }),
    });
    t.view({ id: 1, method: "resources/read", params: { uri: "app://secrets" } });
    await t.settle();
    expect(t.answerTo(1)?.error).toEqual({
      code: -32000,
      message: "resources/read refused (failed)",
      data: { code: "not_allowed", message: "Only issues are shown here." },
    });
  });

  it("passes a teardown request on to the framework", () => {
    const t = setup();
    t.view({ method: "ui/notifications/request-teardown" });
    expect(t.events).toEqual([{ type: "teardown-requested" }]);
  });

  it("hands the sandbox proxy the view's HTML, once", () => {
    const t = setup({ document: "<p>view</p>" });
    t.view({ method: "ui/notifications/sandbox-proxy-ready", params: {} });
    t.view({ method: "ui/notifications/sandbox-proxy-ready", params: {} });
    expect(t.sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "<p>view</p>" },
      },
    ]);
  });
});

describe("teardown and close", () => {
  it("asks an initialized view to clean up and waits for its answer", async () => {
    const t = setup();
    await t.initialize();
    let finished = false;
    const done = t.connection.teardown().then(() => {
      finished = true;
    });
    const request = t.sent.at(-1) as Message;
    expect(request.method).toBe("ui/resource-teardown");
    await t.settle();
    expect(finished).toBe(false);
    t.view({ id: request.id, result: {} });
    await done;
    expect(finished).toBe(true);
  });

  it("gives up on a view that doesn't answer, and doesn't ask one that never initialized", async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ adapter: { teardownTimeoutMs: 50 } });
      await t.connection.teardown();
      expect(t.sent).toEqual([]);
      t.view({ method: "ui/notifications/initialized" });
      const done = t.connection.teardown();
      vi.advanceTimersByTime(60);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops listening when closed", () => {
    const t = setup();
    t.connection.close();
    expect(t.isListening()).toBe(false);
  });
});

describe("a view's resource", () => {
  it("maps declared domains to egress, dropping what isn't an origin and opening no frames", () => {
    expect(
      viewEgress({
        connectDomains: [
          "https://api.example.com/",
          "wss://live.example.com",
          "'self'",
          "*",
          "https://x.com/path",
        ],
        resourceDomains: [
          "https://*.cdn.example.com",
          "HTTPS://Fonts.Example.com",
          // A wildcard over a public suffix opens every stranger's site: dropped (P060).
          "https://*.com",
          "https://*.github.io",
        ],
        frameDomains: ["https://www.youtube.com"],
        baseUriDomains: ["https://base.example.com"],
      }),
    ).toEqual({
      connect: ["https://api.example.com", "wss://live.example.com"],
      script: ["https://*.cdn.example.com", "https://fonts.example.com"],
      style: ["https://*.cdn.example.com", "https://fonts.example.com"],
      img: ["https://*.cdn.example.com", "https://fonts.example.com"],
      font: ["https://*.cdn.example.com", "https://fonts.example.com"],
      media: ["https://*.cdn.example.com", "https://fonts.example.com"],
    });
    expect(viewEgress(undefined)).toEqual({});
  });

  it("reads the view from a resources/read result, as text or base64", () => {
    const meta = {
      ui: { csp: { connectDomains: ["https://api.example.com"] }, prefersBorder: false },
    };
    expect(
      readViewResource({
        contents: [
          { uri: "ui://a", mimeType: "text/html;profile=mcp-app", text: "<p>a</p>", _meta: meta },
        ],
      }),
    ).toEqual({
      uri: "ui://a",
      html: "<p>a</p>",
      egress: { connect: ["https://api.example.com"] },
      prefersBorder: false,
    });
    expect(
      readViewResource({
        contents: [
          {
            uri: "ui://b",
            mimeType: "text/html;profile=mcp-app",
            blob: btoa("<p>é</p>".replace(/é/u, "\u00c3\u00a9")),
          },
        ],
      })?.html,
    ).toBe("<p>é</p>");
    expect(
      readViewResource({ contents: [{ uri: "x", mimeType: "text/plain", text: "no" }] }),
    ).toBeNull();
  });
});

describe("the standard style variables", () => {
  it("are exactly the official SDK's (read from the SDK an example server ships with)", () => {
    const require = createRequire(import.meta.url);
    const sdk = createRequire(require.resolve("@modelcontextprotocol/server-basic-vanillajs"));
    const schema = JSON.parse(
      readFileSync(sdk.resolve("@modelcontextprotocol/ext-apps/schema.json"), "utf8"),
    ) as { $defs: { McpUiStyleVariableKey: { anyOf: { const: string }[] } } };
    const names = schema.$defs.McpUiStyleVariableKey.anyOf.map((each) => each.const);
    expect([...MCP_APPS_STYLE_VARIABLES].sort()).toEqual(names.sort());
  });
});
