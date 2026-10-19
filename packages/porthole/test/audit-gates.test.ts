import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  compile,
  presets,
  type CapabilityHandlers,
  type ConfirmRequest,
  type PageDeclaration,
  type PortholeConfig,
  type SubscriptionContext,
  type ViewerInfo,
} from "../src/index.ts";
import { createBridge, onceConsent, type BridgeOptions } from "../src/bridge/bridge.ts";
import { liveData } from "../src/protocol/live-data.ts";
import { ConfirmDialog } from "../src/react/dialog.tsx";

/**
 * The 2026-10-19 audit's gate findings (P094), at the lowest layer that sees each: S03 the page's
 * data names held with a viewer and without one; S04 a read answered from a result the host
 * pushed is authorized as every read; C01 a db batch runs under its writes' gates, a watch under
 * its read's.
 */

const ORIGINS = ["https://*.example-usercontent.com"];
const runtime = (capabilities: PortholeConfig["capabilities"]): PortholeConfig =>
  presets.artifact({ isolation: "domain", contentOrigins: ORIGINS, runtime: "1", capabilities });
const declared = (capabilities: PageDeclaration["capabilities"]): PageDeclaration => ({
  capabilities,
  runtime: "1",
});
const viewer = (level: ViewerInfo["level"], id = "ada"): ViewerInfo => ({ level, id });
const result = (uri: string, value: unknown) => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }],
});

/** A bridge with handlers that record what they were asked. */
function bridgeOf(
  config: PortholeConfig,
  options: Partial<Pick<BridgeOptions, "declaration" | "viewer" | "consent" | "cached">> & {
    handlers?: CapabilityHandlers;
    confirm?: boolean;
    activated?: boolean;
  } = {},
) {
  const asked: string[] = [];
  const confirmed: ConfirmRequest[] = [];
  const subscriptions = new Map<string, SubscriptionContext>();
  const handlers: CapabilityHandlers = options.handlers ?? {
    readData: ({ uri }) => {
      asked.push(`readData ${uri}`);
      return result(uri, { from: "handler" });
    },
    subscribeData: ({ uri }, context) => {
      asked.push(`subscribeData ${uri}`);
      subscriptions.set(uri, context);
      return undefined;
    },
    callTool: ({ name }) => {
      asked.push(`callTool ${name}`);
      return { content: [] };
    },
    db: (request) => {
      asked.push(`db ${request.op}`);
      return { version: 1 };
    },
  };
  const bridge = createBridge({
    config,
    display: { id: "d", title: "t" },
    handlers,
    ...(options.confirm === false
      ? {}
      : {
          confirm: (request) => {
            confirmed.push(request);
            return Promise.resolve(true);
          },
        }),
    consent: options.consent ?? (() => true),
    userActivation: () => options.activated ?? true,
    onEvent: () => {},
    ...(options.declaration === undefined ? {} : { declaration: options.declaration }),
    ...(options.viewer === undefined ? {} : { viewer: options.viewer }),
    ...(options.cached === undefined ? {} : { cached: options.cached }),
  });
  return { bridge, asked, confirmed, subscriptions };
}

describe("S03: a page's data names hold whether or not the host gave a viewer", () => {
  const config = runtime({ readData: {}, subscribeData: {}, callTool: { gates: [] } });
  const declaration = declared({
    data: { resources: ["app://allowed", "app://tasks/*"], tools: ["create_task"] },
  });
  const signal = new AbortController().signal;
  const subscription = { subscription: { changed: () => {}, signal } };

  test("the same declaration gets the same names judgement with a viewer and without one (S03)", async () => {
    for (const given of [undefined, viewer("view"), viewer("owner")]) {
      const { bridge, asked } = bridgeOf(config, {
        declaration,
        ...(given === undefined ? {} : { viewer: given }),
      });
      const who = given?.level ?? "no viewer";
      expect(await bridge.call("readData", { uri: "app://outside-list" }), who).toMatchObject({
        refusal: "undeclared",
      });
      expect(
        await bridge.call("subscribeData", { uri: "app://outside-list" }, subscription),
        who,
      ).toMatchObject({ refusal: "undeclared" });
      expect((await bridge.call("readData", { uri: "app://allowed" })).ok, who).toBe(true);
      expect((await bridge.call("readData", { uri: "app://tasks/1" })).ok, who).toBe(true);
      // Nothing outside the list reached the handler.
      expect(asked, who).toEqual(["readData app://allowed", "readData app://tasks/1"]);
    }
  });

  test("without a viewer, a call above view is still refused for its level (S03)", async () => {
    const { bridge, asked } = bridgeOf(config, { declaration });
    // Inside the list and outside it: no viewer is never a level.
    for (const name of ["create_task", "drop_tables"]) {
      expect(await bridge.call("callTool", { name, arguments: {} }), name).toMatchObject({
        refusal: "level",
      });
    }
    expect(asked).toEqual([]);
    // With a viewer who may call tools, the list decides.
    const interact = bridgeOf(config, { declaration, viewer: viewer("interact") });
    expect(
      await interact.bridge.call("callTool", { name: "drop_tables", arguments: {} }),
    ).toMatchObject({ refusal: "undeclared" });
    expect(
      (await interact.bridge.call("callTool", { name: "create_task", arguments: {} })).ok,
    ).toBe(true);
  });

  test("no declaration, or a page from before 0.7, or no runtime: 0.6's reads as before (S03)", async () => {
    const legacy = presets.artifact({
      isolation: "domain",
      contentOrigins: ORIGINS,
      capabilities: { readData: {} },
    });
    for (const [name, bridge] of [
      ["no runtime", bridgeOf(legacy).bridge],
      ["runtime, null declaration", bridgeOf(config, { declaration: null }).bridge],
      ["runtime, no declaration", bridgeOf(config).bridge],
    ] as const) {
      expect((await bridge.call("readData", { uri: "app://anything" })).ok, name).toBe(true);
    }
  });
});

describe("S04: a read is authorized as a read, whether a pushed result, the cache or the handler answers it", () => {
  const uri = "app://issues";

  /** A frame's live data over a bridge: subscribe, then the host pushes a result. */
  async function pushed(
    config: PortholeConfig,
    options: Parameters<typeof bridgeOf>[1] = {},
  ): Promise<ReturnType<typeof bridgeOf> & { live: ReturnType<typeof liveData> }> {
    const made = bridgeOf(config, options);
    const live = liveData(made.bridge, () => {});
    expect((await live.subscribe(uri)).ok).toBe(true);
    made.subscriptions.get(uri)?.changed(result(uri, { from: "push" }));
    return { ...made, live };
  }

  test("a read above the viewer's level: refused cold, and refused after a push (S04)", async () => {
    // Reads need admin; following needs view (the audit's case).
    const config = runtime({ readData: { levels: { read: "admin" } }, subscribeData: {} });
    const options = { declaration: declared({ data: {} }), viewer: viewer("view") };
    const cold = bridgeOf(config, options);
    expect(await liveData(cold.bridge, () => {}).read(uri)).toMatchObject({ refusal: "level" });
    const { live, asked } = await pushed(config, options);
    expect(await live.read(uri)).toMatchObject({ ok: false, refusal: "level" });
    expect(await live.read(uri)).toMatchObject({ ok: false, refusal: "level" });
    expect(asked).toEqual([`subscribeData ${uri}`]);
  });

  test("an admin reads the pushed result without the read handler, once (P079 kept)", async () => {
    const config = runtime({ readData: { levels: { read: "admin" } }, subscribeData: {} });
    const { live, asked } = await pushed(config, {
      declaration: declared({ data: {} }),
      viewer: viewer("admin"),
    });
    expect(await live.read(uri)).toEqual({ ok: true, value: result(uri, { from: "push" }) });
    expect(await live.read(uri)).toEqual({ ok: true, value: result(uri, { from: "handler" }) });
    expect(asked).toEqual([`subscribeData ${uri}`, `readData ${uri}`]);
  });

  test("a host with no read handler: a pushed result still answers, past the gates (P079 kept)", async () => {
    const config = presets.liveWidget();
    const subscriptions = new Map<string, SubscriptionContext>();
    const { live } = await pushed(config, {
      handlers: {
        subscribeData: ({ uri: each }, context) => {
          subscriptions.set(each, context);
          context.changed(result(each, { from: "push" }));
          return undefined;
        },
      },
    });
    expect(await live.read(uri)).toEqual({ ok: true, value: result(uri, { from: "push" }) });
  });

  test("a read's own rate counts reads answered from a push (S04)", async () => {
    const config = presets.liveWidget({
      capabilities: {
        readData: { gates: [{ rateLimit: { perMinute: 1 } }] },
        subscribeData: { gates: [] },
      },
    });
    const { live, subscriptions } = await pushed(config);
    expect((await live.read(uri)).ok).toBe(true);
    subscriptions.get(uri)?.changed(result(uri, { from: "push again" }));
    expect(await live.read(uri)).toMatchObject({ ok: false, refusal: "rate-limited" });
    // A refused read leaves the pushed result for the next one the gates let through.
    expect(await live.read(uri)).toMatchObject({ ok: false, refusal: "rate-limited" });
  });

  test("a read's own consent: a no refuses a pushed result too (S04)", async () => {
    const config = presets.liveWidget({
      capabilities: { readData: { gates: ["consent"] }, subscribeData: { gates: [] } },
    });
    const { live, asked } = await pushed(config, { consent: onceConsent(() => false) });
    expect(await live.read(uri)).toMatchObject({ ok: false, refusal: "denied" });
    expect(asked).toEqual([`subscribeData ${uri}`]);
  });

  test("a read's own gesture: needed for a pushed result too (S04)", async () => {
    const config = presets.liveWidget({
      capabilities: { readData: { gates: ["user-activation"] }, subscribeData: { gates: [] } },
    });
    const { live } = await pushed(config, { activated: false });
    expect(await live.read(uri)).toMatchObject({ ok: false, refusal: "no-user-activation" });
  });

  test("a held result answers only the read it was kept for, and nothing but a read (S04)", async () => {
    const config = presets.liveWidget();
    const { bridge, asked } = bridgeOf(config);
    // A custom adapter that mixes up its keys gets a refusal, never another URI's data.
    expect(
      await bridge.call("readData", { uri: "app://a" }, { held: { uri: "app://b", value: 1 } }),
    ).toMatchObject({ ok: false, refusal: "invalid" });
    expect(
      await bridge.call("readData", { uri: "app://a" }, { held: { uri: "app://a", value: 1 } }),
    ).toEqual({ ok: true, value: 1 });
    expect(asked).toEqual([]);
    // Ignored for anything else: the handler answers.
    const signal = new AbortController().signal;
    expect(
      (
        await bridge.call(
          "subscribeData",
          { uri: "app://a" },
          { held: { uri: "app://a", value: 1 }, subscription: { changed: () => {}, signal } },
        )
      ).ok,
    ).toBe(true);
    expect(asked).toEqual(["subscribeData app://a"]);
  });

  test("the cache and the fresh read after it: every answer past the read's gates (S04)", async () => {
    const config = runtime({ readData: { levels: { read: "admin" } }, subscribeData: {} });
    const cachedAsked: string[] = [];
    const made = bridgeOf(config, {
      declaration: declared({ data: {} }),
      viewer: viewer("view"),
      cached: ({ uri: each }) => {
        cachedAsked.push(each);
        return result(each, { from: "cache" });
      },
    });
    const live = liveData(made.bridge, () => {});
    expect((await live.subscribe(uri)).ok).toBe(true);
    expect(await live.read(uri)).toMatchObject({ ok: false, refusal: "level" });
    expect(cachedAsked).toEqual([]);
    // Allowed: stale from the cache, then the fresh result kept is served as a read again.
    const rate = presets.liveWidget({
      capabilities: {
        readData: { gates: [{ rateLimit: { perMinute: 2 } }] },
        subscribeData: { gates: [] },
      },
    });
    const open = bridgeOf(rate, { cached: ({ uri: each }) => result(each, { from: "cache" }) });
    const followed = liveData(open.bridge, () => {});
    expect((await followed.subscribe(uri)).ok).toBe(true);
    expect((await followed.read(uri)).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The stale read and the fresh one behind it were the minute's two.
    expect(await followed.read(uri)).toMatchObject({ ok: false, refusal: "rate-limited" });
  });
});

describe("C01: a db batch runs under its writes' gates, a watch under its read's", () => {
  const signal = new AbortController().signal;
  const watch = (path: string) =>
    [{ op: "watch", path }, { subscription: { changed: () => {}, signal } }] as const;

  test("a confirmed delete is confirmed inside a batch, once for the whole batch (C01)", async () => {
    const config = runtime({ db: { methodGates: { delete: ["confirm"] } } });
    const options = {
      declaration: declared({ db: {} }),
      viewer: viewer("interact"),
    };
    const unasked = bridgeOf(config, { ...options, confirm: false });
    expect(await unasked.bridge.call("db", { op: "delete", path: "n/x" })).toMatchObject({
      refusal: "no-confirm",
    });
    const batch = {
      op: "batch",
      writes: [
        { op: "set", path: "n/a", data: { v: 1 }, ifVersion: 0 },
        { op: "delete", path: "n/x" },
        { op: "delete", path: "n/y" },
      ],
    };
    expect(await unasked.bridge.call("db", batch)).toMatchObject({ refusal: "no-confirm" });
    // A batch of sets alone isn't asked.
    expect(
      (
        await unasked.bridge.call("db", {
          op: "batch",
          writes: [{ op: "set", path: "n/b", data: {}, ifVersion: 0 }],
        })
      ).ok,
    ).toBe(true);
    const asked = bridgeOf(config, options);
    expect((await asked.bridge.call("db", batch)).ok).toBe(true);
    expect(asked.confirmed).toHaveLength(1);
    // The person is shown every write, and the host told which of them asked.
    expect(asked.confirmed[0]?.args).toMatchObject({
      op: "batch",
      writes: [{ path: "n/a" }, { path: "n/x" }, { path: "n/y" }],
    });
    expect(asked.confirmed[0]?.askedBy).toEqual(["delete"]);
    // Where only the host function's own gates ask, no method is named.
    const whole = bridgeOf(runtime({ db: { gates: ["confirm"] } }), options);
    expect((await whole.bridge.call("db", batch)).ok).toBe(true);
    expect(whole.confirmed[0]?.askedBy).toBeUndefined();
  });

  test("the default dialog leads a batch with the writes that asked, then every write (C01)", () => {
    const big = { text: "x".repeat(2_000) };
    const writes = [
      ...Array.from({ length: 48 }, (_, index) => ({ op: "set", path: `n/s${index}`, data: big })),
      { op: "delete", path: "n/x" },
      { op: "delete", path: "n/y" },
    ];
    const shown = (askedBy?: readonly string[]) =>
      renderToString(
        createElement(ConfirmDialog, {
          request: {
            capability: "db",
            args: { op: "batch", writes },
            display: { id: "d", title: "Board" },
            ...(askedBy === undefined ? {} : { askedBy }),
          } as ConfirmRequest,
          onAnswer: () => {},
        }),
      );
    const html = shown(["delete"]);
    expect(html).not.toContain("Allow this?");
    // Above the details, which scroll: what the gates asked about, however late in the batch.
    expect(html).toContain("Delete n/x, n/y; and 48 other writes.");
    expect(html.indexOf("data-porthole-summary")).toBeGreaterThan(-1);
    expect(html.indexOf("data-porthole-summary")).toBeLessThan(
      html.indexOf("data-porthole-detail"),
    );
    // The host function's own confirmation: every write, by kind, a bounded list.
    expect(shown()).toMatch(/Set n\/s0, n\/s1, .*, n\/s9 and 38 more; delete n\/x, n\/y\./u);
  });

  test("a gesture, a consent and a rate on the writes hold inside a batch (C01)", async () => {
    const options = {
      declaration: declared({ db: {} }),
      viewer: viewer("interact"),
    };
    const set = (path: string) => ({ op: "set", path, data: {}, ifVersion: 0 });
    const still = bridgeOf(runtime({ db: { methodGates: { set: ["user-activation"] } } }), {
      ...options,
      activated: false,
    });
    expect(await still.bridge.call("db", { op: "batch", writes: [set("n/a")] })).toMatchObject({
      refusal: "no-user-activation",
    });
    const refused = bridgeOf(runtime({ db: { methodGates: { update: ["consent"] } } }), {
      ...options,
      consent: onceConsent(() => false),
    });
    expect(
      await refused.bridge.call("db", {
        op: "batch",
        writes: [{ op: "update", path: "n/a", data: {}, ifVersion: 1 }],
      }),
    ).toMatchObject({ refusal: "denied" });
    // A batch's writes count as that many of their method's calls, with the direct ones.
    const rated = bridgeOf(
      runtime({ db: { methodGates: { set: [{ rateLimit: { perMinute: 3 } }] } } }),
      options,
    );
    expect((await rated.bridge.call("db", set("n/a"))).ok).toBe(true);
    expect(
      await rated.bridge.call("db", { op: "batch", writes: [set("n/b"), set("n/c"), set("n/d")] }),
    ).toMatchObject({ refusal: "rate-limited" });
    expect(
      (await rated.bridge.call("db", { op: "batch", writes: [set("n/b"), set("n/c")] })).ok,
    ).toBe(true);
    expect(await rated.bridge.call("db", set("n/e"))).toMatchObject({ refusal: "rate-limited" });
  });

  test("a watch is held to get's gates for a document, query's for a collection (C01)", async () => {
    const config = runtime({ db: { methodGates: { get: ["consent"], query: ["confirm"] } } });
    const options = {
      declaration: declared({ db: {} }),
      viewer: viewer("view"),
    };
    const no = bridgeOf(config, { ...options, consent: onceConsent(() => false), confirm: false });
    expect(await no.bridge.call("db", { op: "get", path: "n/x" })).toMatchObject({
      refusal: "denied",
    });
    expect(await no.bridge.call("db", ...watch("n/x"))).toMatchObject({ refusal: "denied" });
    expect(await no.bridge.call("db", ...watch("n"))).toMatchObject({ refusal: "no-confirm" });
    const yes = bridgeOf(config, options);
    expect((await yes.bridge.call("db", ...watch("n/x"))).ok).toBe(true);
    expect((await yes.bridge.call("db", ...watch("n"))).ok).toBe(true);
    expect(yes.confirmed.map((each) => (each.args as { op: string }).op)).toEqual(["watch"]);
  });

  test("the manual says a batch and a watch carry their methods' gates (C01)", () => {
    const words = compile(runtime({ db: { methodGates: { delete: ["confirm"] } } })).guide([
      "interactive",
    ]);
    expect(words).toMatch(/delete: The app shows the person it first/u);
    expect(words).toMatch(/batch\(writes\) needs what each of its writes needs/u);
    // Nothing said where no db method has gates of its own.
    expect(compile(runtime({ db: {} })).guide(["interactive"])).not.toMatch(
      /needs what each of its writes needs/u,
    );
  });
});
