import { describe, expect, test } from "vitest";
import { createBridge } from "../src/bridge/bridge.ts";
import type { AdapterEvent } from "../src/protocol/adapter.ts";
import type { JsonRpcMessage } from "../src/protocol/jsonrpc.ts";
import { shellAdapter } from "../src/protocol/shell-adapter.ts";
import { compile, presets, type PresetOptions } from "../src/index.ts";

/** The shell adapter over a fake transport: what it sent, and a way to say things to it. */
function connect(options: PresetOptions = {}, confirm = () => Promise.resolve(true)) {
  const sent: JsonRpcMessage[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const events: AdapterEvent[] = [];
  const config = presets.inlineWidget(options);
  const connection = shellAdapter.connect({
    display: { id: "d1", title: "T" },
    compiled: compile(config),
    transport: {
      send: (message) => sent.push(message),
      listen: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => listeners.clear(),
    },
    bridge: createBridge({
      config,
      display: { id: "d1", title: "T" },
      handlers: { sendPrompt: () => true, openLink: () => false },
      confirm,
      onEvent: () => {},
    }),
    hostInfo: { name: "test", version: "1" },
    hostContext: () => ({
      theme: "light",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
    }),
    emit: (event) => events.push(event),
  });
  const say = (message: unknown) => {
    for (const listener of listeners) {
      listener(message);
    }
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { connection, sent, events, say, settle };
}

const initialize = { jsonrpc: "2.0", id: "porthole-shell-1", method: "ui/initialize", params: {} };
const initialized = { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} };

describe("the shell adapter", () => {
  test("answers the handshake with what the config offers", () => {
    const { sent, say } = connect({ capabilities: { sendPrompt: {} } });
    say(initialize);
    expect(sent[0]).toMatchObject({
      jsonrpc: "2.0",
      id: "porthole-shell-1",
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "test", version: "1" },
        hostCapabilities: { message: { text: {} }, logging: {} },
        hostContext: { theme: "light" },
      },
    });
    expect(
      (sent[0] as { result: { hostCapabilities: object } }).result.hostCapabilities,
    ).not.toHaveProperty("openLinks");
  });

  test("holds content until the view has initialized, then sends only the latest", () => {
    const { connection, sent, say, events } = connect();
    connection.setContent("<p>a</p>", { partial: true });
    connection.setContent("<p>ab</p>", { partial: true });
    expect(sent).toEqual([]);
    say(initialize);
    say(initialized);
    expect(events).toEqual([{ type: "initialized" }]);
    expect(sent.slice(1)).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input-partial",
        params: { arguments: { html: "<p>ab</p>" } },
      },
    ]);
  });

  test("streams partials (skipping repeats), then the whole once, and nothing after", () => {
    const { connection, sent, say } = connect();
    say(initialize);
    say(initialized);
    connection.setContent("<p>a", { partial: true });
    connection.setContent("<p>a", { partial: true });
    connection.setContent("<p>ab", { partial: true });
    connection.setContent("<p>abc</p>");
    connection.setContent("<p>abc</p>");
    connection.setContent("<p>late", { partial: true });
    const methods = sent
      .slice(1)
      .map((message) => ("method" in message ? message.method : "response"));
    expect(methods).toEqual([
      "ui/notifications/tool-input-partial",
      "ui/notifications/tool-input-partial",
      "ui/notifications/tool-input",
    ]);
  });

  test("tells the view of a new host context only once it has initialized", () => {
    const { connection, sent, say } = connect();
    connection.hostContextChanged({
      theme: "dark",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
    });
    expect(sent).toEqual([]);
    say(initialize);
    say(initialized);
    connection.hostContextChanged({
      theme: "dark",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
    });
    expect(sent.at(-1)).toMatchObject({
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark" },
    });
  });

  test("answers ui/message through the bridge, as MCP Apps shapes it", async () => {
    const { sent, say, settle } = connect({ capabilities: { sendPrompt: {}, openLink: {} } });
    say({
      jsonrpc: "2.0",
      id: 7,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "Explain" }] },
    });
    await settle();
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    // The handler said the link didn't open: the view hears isError.
    say({ jsonrpc: "2.0", id: 8, method: "ui/open-link", params: { url: "https://example.com" } });
    await settle();
    expect(sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 8, result: { isError: true } });
  });

  test("a refused call is an error result for flagged methods and an error for the rest", async () => {
    const { sent, say, settle } = connect({ capabilities: { sendPrompt: {} } }, () =>
      Promise.resolve(false),
    );
    say({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "x" }] },
    });
    say({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } });
    await settle();
    expect(sent).toContainEqual({ jsonrpc: "2.0", id: 1, result: { isError: true } });
    expect(sent).toContainEqual({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32000,
        message: "Refused (not-declared)",
        data: { code: "not_allowed", message: "This isn't available here." },
      },
    });
  });

  test("an unknown request is 'method not found'; malformed messages and stray responses are dropped", () => {
    const { sent, say } = connect();
    say({ jsonrpc: "2.0", id: 3, method: "ui/do-something-else", params: {} });
    expect(sent.at(-1)).toMatchObject({ id: 3, error: { code: -32601 } });
    const before = sent.length;
    for (const junk of [
      null,
      "x",
      { id: 1, method: "ui/initialize" },
      { jsonrpc: "2.0", id: 99, result: {} },
      { jsonrpc: "2.0", method: "ui/message", params: [1] },
    ]) {
      say(junk);
    }
    expect(sent).toHaveLength(before);
  });

  test("after close it says and hears nothing", () => {
    const { connection, sent, say } = connect();
    connection.close();
    say(initialize);
    connection.setContent("<p>x</p>");
    expect(sent).toEqual([]);
  });
});
