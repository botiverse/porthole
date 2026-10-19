import { describe, expect, test } from "vitest";
import { createBridge, type BridgeEvent } from "../src/bridge/bridge.ts";
import { boundedText } from "../src/bridge/bounded-text.ts";
import { withoutSealedAddresses } from "../src/bridge/navigation.ts";
import { compile, presets, type PresetOptions } from "../src/index.ts";
import { mcpAppsAdapter } from "../src/mcp/index.ts";
import type { ProtocolAdapter } from "../src/protocol/adapter.ts";
import { shellAdapter } from "../src/protocol/shell-adapter.ts";

/**
 * S05 (the 2026-10-19 audit, P095): an error log from the frame (`notifications/message`) is the
 * content's word. It is read only within reportError's declaration and rate, into text bounded in
 * nodes, depth and length whatever structured clone delivered (cycles, shared references, BigInt,
 * depth), and nothing it holds throws out of the adapter.
 */

const ADAPTERS: readonly (readonly [string, ProtocolAdapter, typeof presets.inlineWidget])[] = [
  ["the shell adapter", shellAdapter, presets.inlineWidget],
  ["the MCP Apps adapter", mcpAppsAdapter(), presets.mcpApp],
];

/** An adapter over a fake transport and the real bridge: what the host heard, and a way to log. */
function connect(
  adapter: ProtocolAdapter,
  preset: typeof presets.inlineWidget,
  options: PresetOptions = {},
) {
  const config = preset(options);
  const events: BridgeEvent[] = [];
  const sent: unknown[] = [];
  let prompted = 0;
  const listeners = new Set<(message: unknown) => void>();
  adapter.connect({
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
      handlers: {
        sendPrompt: () => {
          prompted += 1;
          return true;
        },
      },
      confirm: () => Promise.resolve(true),
      onEvent: (event) => events.push(event),
    }),
    hostInfo: { name: "test", version: "1" },
    hostContext: () => ({
      theme: "light",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
    }),
    emit: () => {},
  });
  const raw = (message: Record<string, unknown>) => {
    for (const listener of listeners) {
      listener({ jsonrpc: "2.0", ...message });
    }
  };
  const say = (params: Record<string, unknown>) => raw({ method: "notifications/message", params });
  const log = (data: unknown) => say({ level: "error", data });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const errors = () => events.flatMap((event) => (event.type === "error" ? [event.message] : []));
  const answered = (id: number) =>
    sent.some((message) => (message as { id?: unknown; method?: unknown }).id === id);
  return { events, raw, say, log, settle, errors, answered, prompted: () => prompted };
}

/** A value whose every read is counted: what an adapter or the bridge read of it. */
function counted(): { readonly value: object; readonly reads: () => number } {
  let reads = 0;
  const value = {
    get secret() {
      reads += 1;
      return "read";
    },
  };
  return { value, reads: () => reads };
}

/** A graph of `levels` objects, each holding the next twice: 2^levels nodes written as a tree. */
function shared(levels: number, leaf: unknown = 1): unknown {
  let node: unknown = leaf;
  for (let index = 0; index < levels; index += 1) {
    node = { a: node, b: node };
  }
  return node;
}

/** An object nested `depth` deep. */
function deep(depth: number): unknown {
  let node: unknown = {};
  for (let index = 0; index < depth; index += 1) {
    node = { a: node };
  }
  return node;
}

describe.each(ADAPTERS)("S05: an error log, through %s", (_, adapter, preset) => {
  test("where reportError isn't declared, nothing of it is read", async () => {
    const t = connect(adapter, preset, { errors: "none" });
    const data = counted();
    t.log(data.value);
    t.log(shared(20));
    await t.settle();
    expect(data.reads()).toBe(0);
    expect(t.errors()).toEqual([]);
    expect(t.events).toContainEqual({
      type: "refused",
      capability: "reportError",
      refusal: "not-declared",
    });
  });

  test("past its rate, nothing of it is read", async () => {
    const t = connect(adapter, preset);
    for (let index = 0; index < 10; index += 1) {
      t.log(`e${index}`);
    }
    const data = counted();
    t.log(data.value);
    t.log(shared(20));
    await t.settle();
    expect(data.reads()).toBe(0);
    expect(t.errors()).toHaveLength(10);
    expect(t.events.filter((event) => event.type === "refused")).toEqual([
      { type: "refused", capability: "reportError", refusal: "rate-limited" },
      { type: "refused", capability: "reportError", refusal: "rate-limited" },
    ]);
  });

  test("a cycle, a BigInt and a level that can't be a string never throw out of the adapter", async () => {
    const t = connect(adapter, preset);
    const cycle: Record<string, unknown> = { name: "loop" };
    cycle.self = cycle;
    expect(() => t.log(cycle)).not.toThrow();
    expect(() => t.log({ n: 10n })).not.toThrow();
    expect(() => t.log(5n)).not.toThrow();
    // An own `toString` that isn't a function: `String(level)` throws on it.
    expect(() => t.say({ level: { toString: 0 }, data: "x" })).not.toThrow();
    await t.settle();
    expect(t.errors()).toEqual(['{"name":"loop","self":"[Circular]"}', '{"n":"10n"}', '"5n"']);
  });

  test("a shared graph reads each object once, and a deep one stops at its depth", async () => {
    const t = connect(adapter, preset);
    const data = counted();
    // The audit's case: 13 objects, 53,237 characters as JSON.
    t.log(shared(13));
    // 2^24 reads of one getter as a tree; once here.
    t.log(shared(12, data.value));
    t.log(deep(100_000));
    await t.settle();
    expect(data.reads()).toBe(1);
    const [graph, leaf, nested] = t.errors();
    expect(graph?.length).toBeLessThanOrEqual(2_000);
    expect(graph).toContain('"[Repeated]"');
    expect(leaf).toContain('"secret":"read"');
    expect(nested).toContain('"[Object]"');
    expect(nested?.length).toBeLessThan(200);
  });

  test("anything a log holds that throws when read is no throw out of the adapter", async () => {
    const t = connect(adapter, preset);
    const hostile = {
      ok: 1,
      get bad(): never {
        throw new Error("read me not");
      },
    };
    expect(() => t.log(hostile)).not.toThrow();
    await t.settle();
    expect(t.errors()).toEqual(['{"ok":1,"bad":"[unreadable]"}']);
  });
});

describe.each(ADAPTERS)(
  "S05's class: a request read before any gate, through %s",
  (_, adapter, preset) => {
    test("a message's text is read bounded: a sparse array, a block shared a thousand times", async () => {
      const t = connect(adapter, preset, { capabilities: { sendPrompt: {} } });
      const sparse: unknown[] = [];
      sparse.length = 2 ** 32 - 1;
      const block = { type: "text", text: "x".repeat(100_000) };
      const many = Array.from({ length: 1_000 }, () => block);
      for (const [id, content] of [
        [1, sparse],
        [2, many],
      ] as const) {
        expect(() =>
          t.raw({ id, method: "ui/message", params: { role: "user", content } }),
        ).not.toThrow();
      }
      const hello = [{ type: "text", text: "hello" }];
      t.raw({ id: 3, method: "ui/message", params: { role: "user", content: hello } });
      await t.settle();
      // Both answered, as malformed (no block of text) and too long; only the third reached the host.
      expect([1, 2, 3].every((id) => t.answered(id))).toBe(true);
      expect(t.events).toContainEqual({
        type: "refused",
        capability: "sendPrompt",
        refusal: "invalid",
      });
      expect(t.prompted()).toBe(1);
    });

    test("a method named after Object's own is no request: answered, never thrown", async () => {
      const t = connect(adapter, preset);
      for (const [id, method] of [
        [1, "constructor"],
        [2, "toString"],
        [3, "__proto__"],
      ] as const) {
        expect(() => t.raw({ id, method, params: {} })).not.toThrow();
      }
      await t.settle();
      expect([1, 2, 3].every((id) => t.answered(id))).toBe(true);
    });
  },
);

describe("S05: boundedText, the one formatter of what content said", () => {
  test("JSON as JSON.stringify writes it, a string as it is", () => {
    const plain = { a: [1, "two", null, true, { b: -0.5 }], c: 'é\n"', d: undefined };
    expect(boundedText(plain)).toBe(JSON.stringify(plain));
    expect(boundedText([undefined, () => 1, Symbol("s"), Number.NaN])).toBe(
      "[null,null,null,null]",
    );
    expect(boundedText("as it is")).toBe("as it is");
    expect(boundedText(null)).toBe("null");
    expect(boundedText(7)).toBe("7");
  });

  test("what JSON can't write, said in a word", () => {
    expect(boundedText(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(boundedText(new Date(Number.NaN))).toBe('"Invalid Date"');
    expect(boundedText(new TypeError("bad"))).toBe('"TypeError: bad"');
    expect(boundedText({ m: new Map([[1, 2]]), s: new Set(), u: new Uint8Array(1e6) })).toBe(
      '{"m":"[Map]","s":"[Set]","u":"[Uint8Array]"}',
    );
    expect(boundedText([10n ** 5_000n, -3n])).toBe('["[BigInt]","-3n"]');
  });

  test("a shared reference is written once, a cycle once, at any size", () => {
    const leaf = { x: 1 };
    expect(boundedText({ a: leaf, b: leaf })).toBe('{"a":{"x":1},"b":"[Repeated]"}');
    const list: unknown[] = [];
    list.push(list);
    expect(boundedText(list)).toBe('["[Circular]"]');
    expect(boundedText(shared(1_000)).length).toBeLessThan(500);
  });

  test("bounded in nodes, depth and length: what doesn't fit ends in …", () => {
    const wide: unknown[] = [];
    wide.length = 1e9;
    const text = boundedText(wide, { chars: 8_000, nodes: 50, depth: 16 });
    expect(text).toBe(`[${Array.from({ length: 49 }, () => "null").join(",")},…]`);
    expect(boundedText({ s: "x".repeat(1e7) }, { chars: 100, nodes: 10, depth: 4 })).toHaveLength(
      100,
    );
    expect(boundedText("x".repeat(1e7), { chars: 100, nodes: 10, depth: 4 })).toHaveLength(100);
    expect(boundedText(deep(10), { chars: 100, nodes: 100, depth: 2 })).toBe(
      '{"a":{"a":"[Object]"}}',
    );
  });

  test("a cut never ends inside a sealed address's access: what is left, the scrub takes", () => {
    const address = `https://c.example/__porthole/f/${"A".repeat(40)}/app.js`;
    const text = `${"x".repeat(80)} at ${address}`;
    for (let chars = 80; chars <= text.length; chars += 1) {
      for (const said of [text, { stack: text }]) {
        expect(
          withoutSealedAddresses(boundedText(said, { chars, nodes: 10, depth: 4 })),
        ).not.toMatch(/__porthole\/f\/A/u);
      }
    }
    expect(boundedText(text, { chars: 1_000, nodes: 10, depth: 4 })).toBe(text);
  });
});

describe("S05: the bridge reads an error report after its rate, and scrubs it after the cut", () => {
  test("a sealed address is ./ wherever it falls in a long report", async () => {
    const events: BridgeEvent[] = [];
    const bridge = createBridge({
      config: presets.inlineWidget(),
      display: { id: "d1", title: "T" },
      handlers: {},
      onEvent: (event) => events.push(event),
    });
    const address = `https://c.example/__porthole/f/${"A".repeat(40)}/app.js`;
    await bridge.call("reportError", { message: `${"x".repeat(1_990)} ${address}` });
    await bridge.call("reportError", { message: { stack: `${"y".repeat(1_970)} ${address}` } });
    await bridge.call("reportError", { message: `${address} `.repeat(500) });
    const messages = events.flatMap((event) => (event.type === "error" ? [event.message] : []));
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(2_000);
      expect(message).not.toMatch(/__porthole\/f\/A/u);
    }
    expect(messages[2]?.startsWith("./app.js ./app.js ")).toBe(true);
  });
});
