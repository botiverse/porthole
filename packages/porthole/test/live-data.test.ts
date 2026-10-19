import { describe, expect, test } from "vitest";
import { createBridge, onceConsent, type BridgeEvent } from "../src/bridge/bridge.ts";
import type {
  CapabilityHandlers,
  Consent,
  ConfirmRequest,
  DataCache,
  SubscriptionContext,
} from "../src/bridge/types.ts";
import type { JsonRpcMessage } from "../src/protocol/jsonrpc.ts";
import { shellAdapter } from "../src/protocol/shell-adapter.ts";
import {
  ConfigError,
  compile,
  LIBRARY_CDNS,
  presets,
  STALE_META,
  validateConfig,
  type PortholeConfig,
  type PresetOptions,
} from "../src/index.ts";

/**
 * Live data (P079): the `consent` gate, `subscribeData` and the host's cache, at the bridge and
 * over the wire the shell adapter speaks (MCP `resources/read`, `resources/subscribe`,
 * `resources/unsubscribe`, `notifications/resources/updated`), and the live widget preset.
 */

const json = (value: unknown, uri = "app://issues") => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }],
});

/** A live widget's bridge and adapter over a fake transport, with a data source to drive. */
function live(
  options: {
    preset?: PresetOptions;
    consent?: Consent | null;
    cached?: DataCache;
    handlers?: CapabilityHandlers;
  } = {},
) {
  const sent: JsonRpcMessage[] = [];
  const events: BridgeEvent[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const asked: ConfirmRequest[] = [];
  const reads: string[] = [];
  const subscriptions = new Map<string, SubscriptionContext>();
  let version = 1;
  const config = presets.liveWidget(options.preset ?? {});
  // The consent createHost passes: the host's, asked once per display.
  const own = options.consent ?? (() => true);
  const consent: Consent | undefined =
    options.consent === null
      ? undefined
      : onceConsent((request) => {
          asked.push(request);
          return own(request);
        });
  const bridge = createBridge({
    config,
    display: { id: "d1", title: "Issues" },
    handlers: options.handlers ?? {
      readData: ({ uri }) => {
        reads.push(uri);
        return json({ version }, uri);
      },
      subscribeData: ({ uri }, context) => {
        subscriptions.set(uri, context);
        context.signal.addEventListener("abort", () => subscriptions.delete(uri));
        return undefined;
      },
    },
    ...(consent === undefined ? {} : { consent }),
    ...(options.cached === undefined ? {} : { cached: options.cached }),
    onEvent: (event) => events.push(event),
  });
  const connection = shellAdapter.connect({
    display: { id: "d1", title: "Issues" },
    compiled: compile(config),
    transport: {
      send: (message) => sent.push(message),
      listen: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => listeners.clear(),
    },
    bridge,
    hostInfo: { name: "test", version: "1" },
    hostContext: () => ({
      theme: "light",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
    }),
    emit: () => {},
  });
  let id = 0;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Sends a request as the frame does, and resolves with the host's answer to it. */
  const ask = async (method: string, params: Record<string, unknown>) => {
    const mine = `shell-${++id}`;
    for (const listener of listeners) {
      listener({ jsonrpc: "2.0", id: mine, method, params });
    }
    for (let tries = 0; tries < 20; tries += 1) {
      await settle();
      const found = sent.find((message) => "id" in message && message.id === mine);
      if (found !== undefined) {
        return found as { result?: Record<string, unknown>; error?: { message: string } };
      }
    }
    throw new Error(`no answer to ${method}`);
  };
  const updates = () =>
    sent.filter(
      (message) => "method" in message && message.method === "notifications/resources/updated",
    );
  return {
    config,
    bridge,
    connection,
    sent,
    events,
    asked,
    reads,
    subscriptions,
    ask,
    updates,
    settle,
    bump: () => (version += 1),
  };
}

describe("the live widget preset (P079)", () => {
  test("closed egress, the data capabilities behind consent and a rate, libraries when served", () => {
    const opaque = presets.liveWidget();
    expect(opaque.mode).toBe("inline");
    expect(opaque.egress).toEqual({});
    expect(opaque.capabilities.readData?.gates).toEqual([
      "consent",
      { rateLimit: { perMinute: 120 } },
    ]);
    expect(opaque.capabilities.subscribeData?.gates).toEqual([
      "consent",
      { rateLimit: { perMinute: 60 } },
    ]);
    const served = presets.liveWidget({
      isolation: "domain",
      contentOrigins: ["https://*.example-usercontent.com"],
    });
    expect(served.egress).toEqual({ libraries: true });
  });

  test("its CSP opens nothing but its own origin's library path", () => {
    const served = compile(
      presets.liveWidget({
        isolation: "domain",
        contentOrigins: ["https://*.example-usercontent.com"],
      }),
    );
    expect(served.csp).toBe(
      "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: https://*.example-usercontent.com/__porthole/lib/; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; media-src data: blob:; connect-src 'none'; worker-src blob:; child-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'",
    );
    const opaque = compile(presets.liveWidget());
    expect(opaque.csp).not.toContain("__porthole");
    expect(opaque.csp).toContain("connect-src 'none'");
    expect(opaque.csp).not.toContain("'self'");
  });

  test("refuses egress: no option opens a live widget's network", () => {
    expect(() =>
      presets.liveWidget({ egress: LIBRARY_CDNS } as unknown as PresetOptions),
    ).toThrowError(ConfigError);
  });

  // P103.1: a capability's own origins (`connect`, `resource`) are egress too: the CSP lists them
  // (`egressOrigins`). A live widget refuses them, naming the option, for every capability.
  test("refuses a capability's own origins too, naming the option (P103)", () => {
    const refusal = (options: PresetOptions): string => {
      try {
        presets.liveWidget(options);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        return (error as ConfigError).path;
      }
      return "accepted";
    };
    const origin = ["https://collect.example.org"];
    for (const name of ["readData", "subscribeData", "openLink", "copyText", "callTool"] as const) {
      expect(refusal({ capabilities: { [name]: { connect: origin } } }), name).toBe(
        `options.capabilities.${name}.connect`,
      );
      expect(refusal({ capabilities: { [name]: { resource: origin } } }), name).toBe(
        `options.capabilities.${name}.resource`,
      );
    }
    // Served as well, through defineDisplays' `served` options alike: the same refusal.
    expect(
      refusal({
        isolation: "domain",
        contentOrigins: ["https://*.example-usercontent.com"],
        capabilities: { readData: { gates: [], connect: origin } },
      }),
    ).toBe("options.capabilities.readData.connect");
    // What a live widget may change about a capability stays open: its gates, its manual entry.
    expect(
      compile(
        presets.liveWidget({
          capabilities: { readData: { gates: ["consent"], guide: "- readData(uri): data." } },
        }),
      ).csp,
    ).toContain("connect-src 'none'");
  });

  test("libraries need domain isolation; subscribeData needs readData; consent is a gate", () => {
    const base = presets.inlineWidget();
    expect(() => validateConfig({ ...base, egress: { libraries: true } })).toThrowError(
      /domain isolation only/u,
    );
    expect(() =>
      validateConfig({
        ...base,
        capabilities: { ...base.capabilities, subscribeData: {} },
      } satisfies PortholeConfig),
    ).toThrowError(/needs readData/u);
    expect(() =>
      validateConfig({
        ...base,
        capabilities: { ...base.capabilities, readData: { gates: ["consent"] } },
      }),
    ).not.toThrow();
  });

  test("the shell defines readData and subscribeData, and the manual teaches both", () => {
    const compiled = compile(presets.liveWidget());
    expect(compiled.shell?.globals).toEqual(["readData", "subscribeData"]);
    const manual = compiled.guide(["interactive"]);
    expect(manual).toContain("- readData(uri):");
    expect(manual).toContain("- subscribeData(uri, onData, onError):");
    expect(manual).toContain("asks the person to allow it");
  });
});

describe("the consent gate (P079)", () => {
  test("asked once, before the first data call; a yes lets every call through", async () => {
    const { bridge, asked, reads } = live();
    expect(await bridge.call("readData", { uri: "app://a" })).toMatchObject({ ok: true });
    expect(await bridge.call("readData", { uri: "app://b" })).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      capability: "readData",
      args: { uri: "app://a" },
      display: { id: "d1", title: "Issues" },
    });
    expect(reads).toEqual(["app://a", "app://b"]);
  });

  test("a no refuses every data call, and no handler runs", async () => {
    const { bridge, reads, events } = live({ consent: () => false });
    const denied = { code: "denied", message: "You didn't allow this to read your data." };
    expect(await bridge.call("readData", { uri: "app://a" })).toEqual({
      ok: false,
      refusal: "denied",
      reason: denied,
    });
    expect(
      await bridge.call(
        "subscribeData",
        { uri: "app://a" },
        { subscription: { changed: () => {}, signal: new AbortController().signal } },
      ),
    ).toEqual({ ok: false, refusal: "denied", reason: denied });
    expect(reads).toEqual([]);
    expect(events).toContainEqual({ type: "refused", capability: "readData", refusal: "denied" });
  });

  test("no consent function: refused, fail closed", async () => {
    const { bridge, reads } = live({ consent: null });
    expect(await bridge.call("readData", { uri: "app://a" })).toEqual({
      ok: false,
      refusal: "no-consent",
      reason: { code: "not_allowed", message: "This data isn't available here." },
    });
    expect(reads).toEqual([]);
  });

  test("a consent that throws is a no, and is asked again at the next call", async () => {
    let down = true;
    const { bridge, asked } = live({
      consent: () => {
        if (down) {
          throw new Error("the host's store is down");
        }
        return true;
      },
    });
    // No answer yet: content is told it needs the viewer's consent (P080).
    expect(await bridge.call("readData", { uri: "app://a" })).toMatchObject({
      refusal: "denied",
      reason: { code: "consent_required" },
    });
    down = false;
    expect(await bridge.call("readData", { uri: "app://a" })).toMatchObject({ ok: true });
    expect(await bridge.call("readData", { uri: "app://a" })).toMatchObject({ ok: true });
    expect(asked).toHaveLength(2);
  });

  test("a no is kept: the host is never asked again for this display", async () => {
    const { bridge, asked } = live({ consent: () => false });
    await bridge.call("readData", { uri: "app://a" });
    await bridge.call("readData", { uri: "app://b" });
    expect(asked).toHaveLength(1);
  });

  test("an invalid call is refused before anyone is asked", async () => {
    const { bridge, asked } = live();
    expect(await bridge.call("readData", { uri: "" })).toMatchObject({ refusal: "invalid" });
    expect(await bridge.call("subscribeData", { uri: 7 })).toMatchObject({ refusal: "invalid" });
    expect(asked).toEqual([]);
  });

  test("rates stay gates: a subscription storm is refused past the minute's most", async () => {
    const { bridge } = live();
    const signal = new AbortController().signal;
    const outcomes = [];
    for (let index = 0; index < 61; index += 1) {
      outcomes.push(
        await bridge.call(
          "subscribeData",
          { uri: `app://${index}` },
          { subscription: { changed: () => {}, signal } },
        ),
      );
    }
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(60);
    expect(outcomes.at(-1)).toMatchObject({ refusal: "rate-limited" });
  });
});

describe("live data over MCP's resources/* (P079)", () => {
  test("the host offers subscriptions in serverResources, MCP's own flag", async () => {
    const { ask } = live();
    const answer = await ask("ui/initialize", {});
    expect(answer.result?.hostCapabilities).toMatchObject({
      serverResources: { subscribe: true },
    });
  });

  test("resources/read answers the host's result, after consent", async () => {
    const { ask, asked } = live();
    const answer = await ask("resources/read", { uri: "app://issues" });
    expect(answer.result).toEqual(json({ version: 1 }));
    expect(asked).toHaveLength(1);
  });

  test("subscribe, then each change is told as notifications/resources/updated, and read again", async () => {
    const { ask, subscriptions, updates, reads, bump, settle } = live();
    expect((await ask("resources/subscribe", { uri: "app://issues" })).result).toEqual({});
    const subscription = subscriptions.get("app://issues");
    expect(subscription?.displayId).toBe("d1");
    bump();
    subscription?.changed();
    await settle();
    expect(updates()).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: "app://issues" },
      },
    ]);
    expect((await ask("resources/read", { uri: "app://issues" })).result).toEqual(
      json({ version: 2 }),
    );
    expect(reads).toEqual(["app://issues"]);
  });

  test("a change carrying its result answers the next read without the handler", async () => {
    const { ask, subscriptions, reads } = live();
    await ask("resources/subscribe", { uri: "app://issues" });
    subscriptions.get("app://issues")?.changed(json({ pushed: true }));
    expect((await ask("resources/read", { uri: "app://issues" })).result).toEqual(
      json({ pushed: true }),
    );
    expect(reads).toEqual([]);
    // Used once: the next read is the host's.
    expect((await ask("resources/read", { uri: "app://issues" })).result).toEqual(
      json({ version: 1 }),
    );
  });

  test("a second subscribe to the same URI is one subscription", async () => {
    const { ask, subscriptions, asked } = live();
    await ask("resources/subscribe", { uri: "app://issues" });
    const first = subscriptions.get("app://issues");
    await ask("resources/subscribe", { uri: "app://issues" });
    expect(subscriptions.get("app://issues")).toBe(first);
    expect(asked).toHaveLength(1);
  });

  test("unsubscribe ends the host's subscription; a late change says nothing", async () => {
    const { ask, subscriptions, updates, settle } = live();
    await ask("resources/subscribe", { uri: "app://issues" });
    const subscription = subscriptions.get("app://issues");
    expect((await ask("resources/unsubscribe", { uri: "app://issues" })).result).toEqual({});
    expect(subscription?.signal.aborted).toBe(true);
    subscription?.changed();
    await settle();
    expect(updates()).toEqual([]);
  });

  test("closing the frame ends every subscription", async () => {
    const { ask, subscriptions, connection } = live();
    await ask("resources/subscribe", { uri: "app://a" });
    await ask("resources/subscribe", { uri: "app://b" });
    const all = [...subscriptions.values()];
    connection.close();
    expect(all.every((each) => each.signal.aborted)).toBe(true);
  });

  test("a refused subscription is an error, and leaves nothing behind", async () => {
    const { ask, subscriptions } = live({ consent: () => false });
    const answer = await ask("resources/subscribe", { uri: "app://issues" });
    expect(answer.error?.message).toBe("Refused (denied)");
    expect(subscriptions.size).toBe(0);
    expect((await ask("resources/read", { uri: "app://issues" })).error?.message).toBe(
      "Refused (denied)",
    );
  });

  test("a subscribed read is answered from the host's cache, marked stale, then fresh follows", async () => {
    const { ask, updates, reads, settle } = live({
      cached: ({ uri }) => (uri === "app://issues" ? json({ cached: true }) : undefined),
    });
    await ask("resources/subscribe", { uri: "app://issues" });
    const first = await ask("resources/read", { uri: "app://issues" });
    expect(first.result).toEqual({ ...json({ cached: true }), _meta: { [STALE_META]: true } });
    await settle();
    expect(reads).toEqual(["app://issues"]);
    expect(updates()).toHaveLength(1);
    // The fresh result was kept for this read: the handler isn't asked again.
    expect((await ask("resources/read", { uri: "app://issues" })).result).toEqual(
      json({ version: 1 }),
    );
    expect(reads).toEqual(["app://issues"]);
  });

  test("an unsubscribed read never gets the cache (no update would follow)", async () => {
    const { ask } = live({ cached: () => json({ cached: true }) });
    expect((await ask("resources/read", { uri: "app://issues" })).result).toEqual(
      json({ version: 1 }),
    );
  });

  test("the cache answers only after consent", async () => {
    const cachedAsked: string[] = [];
    const { ask } = live({
      consent: () => false,
      cached: ({ uri }) => {
        cachedAsked.push(uri);
        return json({ cached: true });
      },
    });
    await ask("resources/subscribe", { uri: "app://issues" });
    expect((await ask("resources/read", { uri: "app://issues" })).error?.message).toBe(
      "Refused (denied)",
    );
    expect(cachedAsked).toEqual([]);
  });

  test("without subscribeData, resources/subscribe isn't offered", async () => {
    const { ask } = live({ preset: { capabilities: { subscribeData: false } } });
    expect((await ask("resources/subscribe", { uri: "app://issues" })).error?.message).toMatch(
      /isn't offered here/u,
    );
    const answer = await ask("ui/initialize", {});
    expect(answer.result?.hostCapabilities).toMatchObject({ serverResources: {} });
  });
});
