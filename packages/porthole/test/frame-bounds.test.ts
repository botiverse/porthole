import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { createBridge, type BridgeEvent } from "../src/bridge/bridge.ts";
import type { ConfirmAnswer, ConfirmRequest } from "../src/bridge/types.ts";
import { presets, type PresetOptions } from "../src/index.ts";
import { ConfirmDialog } from "../src/react/index.ts";

/**
 * P095, after S05: the rest of its class. What a frame sends is processed only within bounds, after
 * the cheap gates, and nothing it sends leaves a call without an answer.
 */

/** A graph of `levels` objects, each holding the next twice: 2^levels nodes written as a tree. */
function shared(levels: number): unknown {
  let node: unknown = 1;
  for (let index = 0; index < levels; index += 1) {
    node = { a: node, b: node };
  }
  return node;
}

const display = { id: "d1", title: "Chart" };

/** The confirm dialog's detail for a request, as a server renders it. */
function detail(request: ConfirmRequest): string {
  const html = renderToString(createElement(ConfirmDialog, { request, onAnswer: () => {} }));
  const text = /<div data-porthole-detail="">([\s\S]*?)<\/div>/u.exec(html)?.[1] ?? "";
  return text.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

describe("P095 1: the confirm dialog shows what a call carries, bounded", () => {
  test("a cycle and a BigInt in a tool's arguments render, never throw", () => {
    const cycle: Record<string, unknown> = { name: "loop" };
    cycle.self = cycle;
    const call = (args: Record<string, unknown>): ConfirmRequest => ({
      capability: "callTool",
      args: { name: "t", arguments: args },
      display,
    });
    expect(detail(call(cycle))).toBe('t\n{\n  "name": "loop",\n  "self": "[Circular]"\n}');
    expect(detail(call({ n: 5n }))).toBe('t\n{\n  "n": "5n"\n}');
  });

  test("a shared graph is written once, and what doesn't fit says so", () => {
    const html = renderToString(
      createElement(ConfirmDialog, {
        request: {
          capability: "setModelContext",
          args: { structuredContent: shared(16) },
          display,
        },
        onAnswer: () => {},
      }),
    );
    expect(html.length).toBeLessThan(40_000);
    expect(html).toContain("[Repeated]");
    const long = renderToString(
      createElement(ConfirmDialog, {
        request: {
          capability: "setModelContext",
          args: { content: Array.from({ length: 5_000 }, (_, index) => ({ index })) },
          display,
        },
        onAnswer: () => {},
      }),
    );
    expect(long).toContain("…");
    expect(long).toContain("Only part of it is shown");
  });

  test("plain JSON shows as it did: JSON.stringify's two-space form", () => {
    const args = { a: [1, { b: "x" }], c: {}, d: [] };
    expect(detail({ capability: "callTool", args: { name: "t", arguments: args }, display })).toBe(
      `t\n${JSON.stringify(args, null, 2)}`,
    );
  });
});

/** A bridge over an inline widget's config, recording its events and what it asked to confirm. */
function bridgeOf(options: PresetOptions) {
  const events: BridgeEvent[] = [];
  const asked: ((answer: ConfirmAnswer) => void)[] = [];
  const bridge = createBridge({
    config: presets.inlineWidget(options),
    display,
    handlers: { callTool: () => ({ content: [] }) },
    confirm: () => new Promise<ConfirmAnswer>((resolve) => asked.push(resolve)),
    onEvent: (event) => events.push(event),
  });
  return { bridge, events, asked };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("P095 2: confirmations waiting at once are capped", () => {
  test("past 10 waiting, a call is refused at once, with a reason the page sees", async () => {
    const t = bridgeOf({ capabilities: { callTool: {} } });
    const calls = Array.from({ length: 12 }, () =>
      t.bridge.call("callTool", { name: "t", arguments: {} }),
    );
    await settle();
    expect(t.asked).toHaveLength(10);
    const late = await Promise.all(calls.slice(10));
    for (const outcome of late) {
      expect(outcome).toMatchObject({ ok: false, refusal: "rate-limited" });
      expect(outcome.ok ? null : outcome.reason?.code).toBe("rate_limited");
    }
    // An answer frees a place; a refusal for too many waiting is no decline (nothing muted).
    t.asked[0]?.(true);
    await calls[0];
    const next = t.bridge.call("callTool", { name: "t", arguments: {} });
    await settle();
    expect(t.asked).toHaveLength(11);
    t.asked[10]?.(true);
    expect(await next).toMatchObject({ ok: true });
    expect(t.events.some((event) => event.type === "muted")).toBe(false);
  });
});
