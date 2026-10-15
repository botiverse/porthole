import { afterEach, describe, expect, test } from "vitest";
import {
  createHost,
  isRefused,
  presets,
  REFUSAL_CODES,
  Refused,
  type DisplayEvents,
  type DisplayHandle,
  type HostOptions,
  type PlatformHost,
  type PortholeConfig,
} from "../src/index.ts";
import type { JsonRpcMessage } from "../src/protocol/jsonrpc.ts";

/**
 * 0.5.1 (P080): what a host is told when the shell stops a navigation (#12), a host that refuses
 * every data call without handlers (#13), and the reason content is told for a refusal (#14), on
 * Porthole's own `createHost` over a stand-in platform: the frame's messages in, the host's out.
 */

const json = (value: unknown, uri = "app://issues") => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }],
});

const mounted: DisplayHandle[] = [];
afterEach(() => {
  for (const display of mounted.splice(0)) {
    display.destroy();
  }
});

/** A display under `config` on a stand-in platform: what the frame says, and what it hears. */
function show(config: PortholeConfig, options: HostOptions = {}) {
  const heard: JsonRpcMessage[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const platform: PlatformHost = {
    name: "stand-in",
    createSurface: () => ({
      transport: {
        send: (message) => heard.push(message),
        listen: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: () => listeners.clear(),
      },
      element: null,
      setHeight: () => {},
      setColorScheme: () => {},
      userActivation: () => undefined,
      onNavigated: () => () => {},
      onLoad: () => () => {},
      destroy: () => {},
    }),
  };
  const container = {
    ownerDocument: {
      defaultView: { location: { origin: "https://app.example" }, navigator: { language: "en" } },
    },
    getBoundingClientRect: () => ({ width: 600 }),
  } as unknown as HTMLElement;
  const display = createHost(config, { ...options, platform }).mount(container, {
    displayId: "d1",
    title: "Issues",
    scheme: "light",
  });
  mounted.push(display);
  const events: { -readonly [E in keyof DisplayEvents]?: DisplayEvents[E][] } = {};
  for (const name of ["navigationBlocked", "contentError", "error", "refused"] as const) {
    display.on(name, (detail) => {
      ((events[name] ??= []) as unknown[]).push(detail);
    });
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  let id = 0;
  return {
    display,
    events,
    heard,
    settle,
    /** The frame says something. */
    say(message: Record<string, unknown>) {
      for (const listener of listeners) {
        listener({ jsonrpc: "2.0", ...message });
      }
    },
    /** The frame asks; resolves with the host's answer. */
    async ask(method: string, params: Record<string, unknown>) {
      const mine = `r${++id}`;
      for (const listener of listeners) {
        listener({ jsonrpc: "2.0", id: mine, method, params });
      }
      for (let tries = 0; tries < 20; tries += 1) {
        await settle();
        const found = heard.find((message) => "id" in message && message.id === mine);
        if (found !== undefined) {
          return found as {
            result?: Record<string, unknown>;
            error?: { code: number; message: string; data?: { code: string; message: string } };
          };
        }
      }
      throw new Error(`no answer to ${method}`);
    },
  };
}

const serving = {
  readData: ({ uri }: { readonly uri: string }) => json({ n: 1 }, uri),
  subscribeData: () => undefined,
};

describe("Refused (P080)", () => {
  test("carries a code and a sentence; Porthole's sentence where the host gives none", () => {
    expect(REFUSAL_CODES).toEqual([
      "consent_required",
      "denied",
      "rate_limited",
      "not_allowed",
      "failed",
    ]);
    const own = new Refused("not_allowed", "Live data shows on Today.");
    expect(own).toBeInstanceOf(Error);
    expect([own.name, own.code, own.message]).toEqual([
      "Refused",
      "not_allowed",
      "Live data shows on Today.",
    ]);
    expect(new Refused("rate_limited").message).toBe("Too many requests: try again in a minute.");
    expect(() => new Refused("nope" as "denied")).toThrow(TypeError);
  });

  test("is known by its shape too, where two copies of Porthole meet", () => {
    const elsewhere = Object.assign(new Error("No."), { name: "Refused", code: "denied" });
    expect(isRefused(elsewhere)).toBe(true);
    expect(isRefused(Object.assign(new Error("x"), { name: "Refused", code: "nope" }))).toBe(false);
    expect(isRefused({ name: "Refused", code: "denied", message: "No." })).toBe(false);
  });
});

describe("a refusal tells content why (#14, P080)", () => {
  const config = presets.liveWidget();

  test("the viewer said no: denied, in the error's data", async () => {
    const t = show(config, { handlers: serving, consent: () => false });
    const answer = await t.ask("resources/read", { uri: "app://issues" });
    expect(answer.error).toEqual({
      code: -32000,
      message: "Refused (denied)",
      data: { code: "denied", message: "You didn't allow this to read your data." },
    });
  });

  test("a consent that fails is no answer yet: consent_required, and the next call asks again", async () => {
    let down = true;
    let asked = 0;
    const t = show(config, {
      handlers: serving,
      consent: () => {
        asked += 1;
        if (down) {
          throw new Error("the host's store is down");
        }
        return true;
      },
    });
    expect((await t.ask("resources/read", { uri: "app://issues" })).error?.data?.code).toBe(
      "consent_required",
    );
    down = false;
    expect((await t.ask("resources/read", { uri: "app://issues" })).result).toEqual(json({ n: 1 }));
    expect(asked).toBe(2);
  });

  test("a consent that throws a Refused: its reason, kept for the display's life", async () => {
    let asked = 0;
    const t = show(config, {
      handlers: serving,
      consent: () => {
        asked += 1;
        throw new Refused("denied", "You didn't let this widget read your issues.");
      },
    });
    for (const uri of ["app://issues", "app://pulls"]) {
      expect((await t.ask("resources/read", { uri })).error?.data).toEqual({
        code: "denied",
        message: "You didn't let this widget read your issues.",
      });
    }
    expect(asked).toBe(1);
  });

  test("no consent function: not_allowed", async () => {
    const t = show(config, { handlers: serving });
    expect((await t.ask("resources/read", { uri: "app://issues" })).error?.data).toEqual({
      code: "not_allowed",
      message: "This data isn't available here.",
    });
  });

  test("a handler's Refused: its code and words (a URI the host doesn't serve)", async () => {
    const t = show(config, {
      consent: () => true,
      handlers: {
        ...serving,
        readData: ({ uri }) => {
          if (uri !== "app://issues") {
            throw new Refused("not_allowed", "Only issues are shown here.");
          }
          return json({ n: 1 }, uri);
        },
      },
    });
    expect((await t.ask("resources/read", { uri: "app://secrets" })).error?.data).toEqual({
      code: "not_allowed",
      message: "Only issues are shown here.",
    });
    expect(t.events.refused).toContainEqual({ capability: "readData", refusal: "failed" });
  });

  test("any other error a handler throws: failed, in Porthole's words, never the host's", async () => {
    const t = show(config, {
      consent: () => true,
      handlers: {
        ...serving,
        readData: () => {
          throw new Error("ECONNREFUSED 10.0.0.7:5432 (db-internal)");
        },
      },
    });
    const answer = await t.ask("resources/read", { uri: "app://issues" });
    expect(answer.error?.data).toEqual({
      code: "failed",
      message: "The app couldn't get this data.",
    });
    expect(JSON.stringify(answer)).not.toContain("db-internal");
  });

  test("past the rate: rate_limited", async () => {
    const t = show(
      presets.liveWidget({
        capabilities: { readData: { gates: ["consent", { rateLimit: { perMinute: 1 } }] } },
      }),
      {
        handlers: serving,
        consent: () => true,
      },
    );
    expect((await t.ask("resources/read", { uri: "app://issues" })).result).toBeDefined();
    expect((await t.ask("resources/read", { uri: "app://issues" })).error?.data).toEqual({
      code: "rate_limited",
      message: "Too many data requests: try again in a minute.",
    });
  });

  test("a refused subscription says why too", async () => {
    const t = show(config, { handlers: serving, consent: () => false });
    expect((await t.ask("resources/subscribe", { uri: "app://issues" })).error?.data?.code).toBe(
      "denied",
    );
  });
});

describe("a host that refuses every data call needs no handlers (#13, P080)", () => {
  const refusal = new Refused("not_allowed", "Live data shows on Today, Artifacts and Chat.");

  test("consent: a Refused, and no handlers: it mounts, and every data call is refused with it", async () => {
    const t = show(presets.liveWidget(), { consent: refusal });
    for (const [method, uri] of [
      ["resources/read", "app://issues"],
      ["resources/subscribe", "app://pulls"],
    ] as const) {
      expect((await t.ask(method, { uri })).error?.data).toEqual({
        code: "not_allowed",
        message: "Live data shows on Today, Artifacts and Chat.",
      });
    }
    expect(t.events.refused).toEqual([
      { capability: "readData", refusal: "denied" },
      { capability: "subscribeData", refusal: "denied" },
    ]);
  });

  test("the host's cache isn't asked either", async () => {
    let cacheAsked = 0;
    const t = show(presets.liveWidget(), {
      consent: refusal,
      cached: () => {
        cacheAsked += 1;
        return json({ n: 0 });
      },
    });
    await t.ask("resources/subscribe", { uri: "app://issues" });
    await t.ask("resources/read", { uri: "app://issues" });
    expect(cacheAsked).toBe(0);
  });

  test("only consent-gated capabilities go without: any other declared one still needs its handler", () => {
    expect(() =>
      show(presets.liveWidget({ capabilities: { copyText: {} } }), { consent: refusal }),
    ).toThrow(/No handler for the declared capabilities: copyText/u);
    // A host that took consent off readData's gates serves it.
    expect(() =>
      show(presets.liveWidget({ capabilities: { readData: { gates: [] } } }), {
        consent: refusal,
      }),
    ).toThrow(/readData/u);
  });

  test("a consent function, or none, still needs the handlers (one might allow)", () => {
    expect(() => show(presets.liveWidget(), { consent: () => false })).toThrow(
      /readData, subscribeData/u,
    );
    expect(() => show(presets.liveWidget())).toThrow(/readData, subscribeData/u);
  });
});

describe("a navigation the shell stopped reaches the host (#12, P080)", () => {
  test("navigationBlocked with the address whole; a content error naming it without its query", async () => {
    const t = show(presets.liveWidget({ capabilities: { openLink: {} } }), {
      handlers: { ...serving, openLink: () => true },
    });
    const url = "https://evil.example/collect?d=viewer-secret#x";
    t.say({ method: "porthole/navigation-blocked", params: { url } });
    await t.settle();
    expect(t.events.navigationBlocked).toEqual([{ url }]);
    expect(t.events.contentError).toEqual([
      {
        message:
          "It tried to navigate its frame to https://evil.example/collect?…, and was stopped: content never leaves its page. Open links with openLink(url) or an <a href> (a new tab).",
      },
    ]);
    expect(t.events.error?.[0]).toMatchObject({ source: "content" });
    expect(JSON.stringify(t.events.contentError)).not.toContain("viewer-secret");
  });

  test("an address that isn't http(s) is named by its scheme only", async () => {
    const t = show(presets.inlineWidget());
    t.say({ method: "porthole/navigation-blocked", params: { url: "data:text/html,<p>secret" } });
    await t.settle();
    expect(t.events.contentError?.[0]?.message).toBe(
      "It tried to navigate its frame to a data: address, and was stopped: content never leaves its page.",
    );
  });

  test("it is an error report: none where reportError isn't declared, and within its rate", async () => {
    const silent = show(presets.inlineWidget({ errors: "none" }));
    silent.say({ method: "porthole/navigation-blocked", params: { url: "https://a.example/" } });
    await silent.settle();
    expect(silent.events.navigationBlocked).toBeUndefined();
    expect(silent.events.contentError).toBeUndefined();

    const t = show(presets.inlineWidget());
    for (let index = 0; index < 12; index += 1) {
      t.say({
        method: "porthole/navigation-blocked",
        params: { url: `https://a.example/${index}` },
      });
    }
    await t.settle();
    expect(t.events.navigationBlocked).toHaveLength(10);
  });

  test("a malformed one is dropped as invalid", async () => {
    const t = show(presets.inlineWidget());
    for (const url of [7, "", "x".repeat(5_000)]) {
      t.say({ method: "porthole/navigation-blocked", params: { url } });
    }
    await t.settle();
    expect(t.events.navigationBlocked).toBeUndefined();
    expect(t.events.refused).toEqual([
      { capability: "reportError", refusal: "invalid" },
      { capability: "reportError", refusal: "invalid" },
      { capability: "reportError", refusal: "invalid" },
    ]);
  });
});
