import { describe, expect, test } from "vitest";
import {
  ConfigError,
  DB_LIMITS,
  compile,
  createHost,
  declaredMatch,
  intersectDeclarations,
  parseDbRequest,
  parseViewer,
  presets,
  shellPlan,
  type CapabilityHandlers,
  type PageDeclaration,
  type PlatformHost,
  type PortholeConfig,
  type ViewerInfo,
} from "../src/index.ts";
import { createBridge } from "../src/bridge/bridge.ts";
import { runtimeCalls } from "../src/protocol/runtime-calls.ts";
import { composedRuntime } from "../src/shell/document.ts";
import { pseudonymFor } from "../src/server/index.ts";
import { memoryRuntime } from "../leak/runtime/memory.ts";
import type { JsonRpcMessage } from "../src/protocol/jsonrpc.ts";

/**
 * The security review of 0.7.0's first cut (P091): each finding's regression, at the lowest layer
 * that sees it. The asset library's (item 1) are in `test/assets.test.ts`.
 */

const ORIGINS = ["https://*.example-usercontent.com"];
const runtime = (capabilities: PortholeConfig["capabilities"], extra = {}): PortholeConfig =>
  presets.artifact({
    isolation: "domain",
    contentOrigins: ORIGINS,
    runtime: "1",
    capabilities,
    ...extra,
  });
const declared = (capabilities: PageDeclaration["capabilities"]): PageDeclaration => ({
  capabilities,
  runtime: "1",
});
const viewer = (level: ViewerInfo["level"], id = "ada"): ViewerInfo => ({ level, id });

function bridgeOf(
  config: PortholeConfig,
  options: {
    declaration?: PageDeclaration;
    viewer?: ViewerInfo;
    handlers?: CapabilityHandlers;
    activated?: boolean;
    confirm?: boolean;
  } = {},
) {
  const memory = memoryRuntime();
  const asked: string[] = [];
  const bridge = createBridge({
    config,
    display: { id: "d", title: "t" },
    handlers: options.handlers ?? memory.handlers,
    ...(options.confirm === false
      ? {}
      : {
          confirm: (request) => {
            asked.push(request.capability);
            return Promise.resolve(true);
          },
        }),
    consent: () => true,
    userActivation: () => options.activated ?? true,
    onEvent: () => {},
    ...(options.declaration === undefined ? {} : { declaration: options.declaration }),
    ...(options.viewer === undefined ? {} : { viewer: options.viewer }),
  });
  return { bridge, memory, asked };
}

/** Objects that share children: tiny over postMessage, 2^depth nodes for a naive walk. */
function dag(depth: number, fan = 2): Record<string, unknown> {
  let node: Record<string, unknown> = {};
  for (let level = 0; level < depth; level += 1) {
    const next: Record<string, unknown> = {};
    for (let each = 0; each < fan; each += 1) {
      next[`k${each}`] = node;
    }
    node = next;
  }
  return node;
}

describe("2: db's checks are linear in what was sent, and cheap ones come first", () => {
  test("shared references are refused at once, however deep", () => {
    for (const depth of [22, 31]) {
      const data = structuredClone(dag(depth));
      const started = performance.now();
      expect(parseDbRequest({ op: "set", path: "a/b", data })).toBeNull();
      expect(
        parseDbRequest({ op: "query", collection: "a", where: [["f", "==", data]] }),
      ).toBeNull();
      expect(performance.now() - started).toBeLessThan(50);
    }
    expect(
      parseDbRequest({ op: "set", path: "a/b", data: structuredClone(dag(3, 200)) }),
    ).toBeNull();
  });

  test("a node budget, a where operand's bytes, a batch's one budget", () => {
    const wide = { list: Array.from({ length: DB_LIMITS.maxNodes + 1 }, () => 1) };
    expect(parseDbRequest({ op: "set", path: "a/b", data: wide })).toBeNull();
    const big = "x".repeat(DB_LIMITS.maxOperandBytes);
    expect(parseDbRequest({ op: "query", collection: "a", where: [["f", "==", big]] })).toBeNull();
    const shared = { n: 1 };
    expect(
      parseDbRequest({
        op: "batch",
        writes: [
          { op: "set", path: "a/1", data: { shared } },
          { op: "set", path: "a/2", data: { shared } },
        ],
      }),
    ).toBeNull();
  });

  test("a malformed runtime call is refused before it is read, past the level and the rate", async () => {
    const config = runtime({ db: { gates: [{ rateLimit: { perMinute: 2 } }] } });
    const { bridge, memory } = bridgeOf(config, {
      declaration: declared({ db: {} }),
      viewer: viewer("view"),
    });
    const deep = structuredClone(dag(31));
    expect(await bridge.call("db", { op: "set", path: "a/b", data: deep })).toMatchObject({
      refusal: "level",
    });
    expect(await bridge.call("db", { op: "get", path: "a/b", junk: deep })).toMatchObject({
      ok: true,
    });
    expect(await bridge.call("db", { op: "get", path: "a/b" })).toMatchObject({ ok: true });
    expect(
      await bridge.call("db", { op: "query", collection: "a", where: [["f", "==", deep]] }),
    ).toMatchObject({
      refusal: "rate-limited",
    });
    expect(memory.calls).toHaveLength(2);
  });

  test("reserved field names in a document are refused", () => {
    for (const text of [
      '{"__proto__":{"x":1}}',
      '{"constructor":{"prototype":{}}}',
      '{"a":{"prototype":1}}',
    ]) {
      expect(parseDbRequest({ op: "set", path: "a/b", data: JSON.parse(text) }), text).toBeNull();
    }
  });
});

describe("3: what changes the artifact for everyone asks for a click and a yes", () => {
  const config = runtime({ artifact: {}, assets: {} });
  const declaration = declared({ artifact: {}, assets: {} });

  test("artifact.publish and assets.delete: a gesture, then a confirmation", async () => {
    const publish = { op: "publish", base: "ver_1", files: { "a.txt": { text: "x" } } };
    const still = bridgeOf(config, { declaration, viewer: viewer("admin"), activated: false });
    expect(await still.bridge.call("artifact", publish)).toMatchObject({
      refusal: "no-user-activation",
    });
    const unasked = bridgeOf(config, { declaration, viewer: viewer("admin"), confirm: false });
    expect(await unasked.bridge.call("artifact", publish)).toMatchObject({ refusal: "no-confirm" });
    expect(await unasked.bridge.call("assets", { op: "delete", id: "0".repeat(32) })).toMatchObject(
      {
        refusal: "no-confirm",
      },
    );
    const asked = bridgeOf(config, { declaration, viewer: viewer("admin") });
    expect((await asked.bridge.call("artifact", publish)).ok).toBe(true);
    expect(asked.asked).toEqual(["artifact"]);
    // Reading isn't gated so.
    expect((await unasked.bridge.call("artifact", { op: "get" })).ok).toBe(true);
  });

  test("an upload is confirmed where uploaded code may run, and not where it may not", async () => {
    const upload = { op: "upload", name: "a.png", base64: "aGk=" };
    expect(
      await bridgeOf(config, { declaration, viewer: viewer("admin"), confirm: false }).bridge.call(
        "assets",
        upload,
      ),
    ).toMatchObject({ refusal: "no-confirm" });
    const open = runtime({ assets: { levels: { upload: "interact" } } });
    const plain = bridgeOf(open, {
      declaration: declared({ assets: {} }),
      viewer: viewer("interact"),
      confirm: false,
      handlers: memoryRuntime({ uploadLevel: "interact" }).handlers,
    });
    expect((await plain.bridge.call("assets", upload)).ok).toBe(true);
  });

  test("a host's methodGates replace the contract's; they're checked like gates", async () => {
    const relaxed = runtime({ artifact: { methodGates: { publish: [] } } });
    const { bridge } = bridgeOf(relaxed, {
      declaration: declared({ artifact: {} }),
      viewer: viewer("admin"),
      activated: false,
      confirm: false,
    });
    expect(
      (
        await bridge.call("artifact", {
          op: "publish",
          base: "ver_1",
          files: { "a.txt": { text: "x" } },
        })
      ).ok,
    ).toBe(true);
    expect(() => runtime({ artifact: { methodGates: { nope: [] } } })).toThrow(ConfigError);
    expect(() => runtime({ artifact: { methodGates: { publish: ["often"] } } } as never)).toThrow(
      ConfigError,
    );
    // The shell knows which methods want a gesture, as the manual says.
    expect(shellPlan(runtime({ artifact: {}, assets: {} }))?.methodActivation).toEqual([
      "artifact.publish",
      "assets.delete",
    ]);
    const words = compile(runtime({ artifact: {} })).guide(["interactive"]);
    expect(words).toMatch(
      /publish: The app shows the person it first, and nothing happens unless they confirm\. Call it from a click/u,
    );
  });
});

describe("4: a batch is its writes, a watch its read, at their levels", () => {
  test("host levels on set and delete hold inside a batch; a page's too; a watch at get's or query's", async () => {
    const config = runtime({ db: { levels: { set: "admin", get: "admin", query: "admin" } } });
    const { bridge } = bridgeOf(config, {
      declaration: declared({ db: { levels: { delete: "owner" } } }),
      viewer: viewer("interact"),
    });
    expect(
      await bridge.call("db", { op: "batch", writes: [{ op: "set", path: "n/x", data: {} }] }),
    ).toMatchObject({
      refusal: "level",
    });
    expect(
      await bridge.call("db", { op: "batch", writes: [{ op: "delete", path: "n/x" }] }),
    ).toMatchObject({
      refusal: "level",
    });
    const signal = new AbortController().signal;
    for (const path of ["n/x", "n"]) {
      expect(
        await bridge.call(
          "db",
          { op: "watch", path },
          { subscription: { changed: () => {}, signal } },
        ),
        path,
      ).toMatchObject({ refusal: "level" });
    }
    expect(
      (await bridge.call("db", { op: "batch", writes: [{ op: "update", path: "n/x", data: {} }] }))
        .ok,
    ).toBe(false);
  });
});

describe("5: db never tells a page the viewer's id", () => {
  test("answers and watches say data/users/me", async () => {
    const config = runtime({ db: {}, user: {} });
    const { bridge } = bridgeOf(config, {
      declaration: declared({ db: {} }),
      viewer: viewer("interact", "user_8f3a"),
    });
    await bridge.call("db", { op: "set", path: "data/users/me/prefs", data: { x: 1 } });
    const got = await bridge.call("db", { op: "get", path: "data/users/me/prefs" });
    const listed = await bridge.call("db", { op: "query", collection: "data/users/me" });
    const heard: unknown[] = [];
    await bridge.call(
      "db",
      { op: "watch", path: "data/users/me" },
      {
        subscription: {
          changed: (state) => heard.push(state),
          signal: new AbortController().signal,
        },
      },
    );
    const said = JSON.stringify([got, listed, heard]);
    expect(said).not.toContain("user_8f3a");
    expect(said).toContain("data/users/me/prefs");
  });
});

describe("6: no viewer is never a way past a level", () => {
  test("under a runtime, without a viewer, nothing above view runs, whatever the host set", async () => {
    const config = runtime({
      sendPrompt: { gates: [], levels: { send: "admin" } },
      callTool: { gates: [], levels: { call: "owner" } },
      readData: {},
    });
    const { bridge, memory } = bridgeOf(config, { declaration: declared({ chat: {}, data: {} }) });
    expect(await bridge.call("sendPrompt", { text: "hi" })).toMatchObject({ refusal: "level" });
    expect(await bridge.call("callTool", { name: "t", arguments: {} })).toMatchObject({
      refusal: "level",
    });
    expect((await bridge.call("readData", { uri: "app://x" })).ok).toBe(true);
    expect(memory.calls.map((each) => each.capability)).toEqual(["readData"]);
  });

  test("a viewer that doesn't parse is an error, at mount and in a location", async () => {
    expect(parseViewer({ level: "view", id: "a/b" })).toBeNull();
    expect(parseViewer({ level: "view", id: "me" })).toBeNull();
    expect(parseViewer({ level: "view", id: ".." })).toBeNull();
    expect(parseViewer({ level: "view", id: "user_1" })).toEqual({ level: "view", id: "user_1" });
  });
});

describe("7: rules are the page's own names, never a prototype's", () => {
  test("constructor, __proto__, toString: under the * rule", async () => {
    const config = runtime({ db: {} });
    const { bridge } = bridgeOf(config, {
      declaration: declared({ db: { rules: { "*": { read: "admin", write: "admin" } } } }),
      viewer: viewer("interact"),
    });
    for (const top of [
      "notes",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      expect(await bridge.call("db", { op: "set", path: `${top}/x`, data: {} }), top).toMatchObject(
        {
          refusal: "level",
        },
      );
    }
  });
});

const container = {
  ownerDocument: {
    defaultView: { location: { origin: "https://app.example" }, navigator: { language: "en" } },
  },
  getBoundingClientRect: () => ({ width: 600 }),
} as unknown as HTMLElement;

function show(config: PortholeConfig, declaration: PageDeclaration | null, who?: ViewerInfo) {
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
      userActivation: () => true,
      onNavigated: () => () => {},
      onLoad: () => () => {},
      destroy: () => {},
    }),
  };
  const memory = memoryRuntime();
  const display = createHost(config, {
    handlers: memory.handlers,
    platform,
    confirm: async () => true,
  }).mount(container, {
    displayId: "d",
    title: "t",
    scheme: "light",
    declaration,
    ...(who === undefined ? {} : { viewer: who }),
  });
  let id = 0;
  const say = (message: Record<string, unknown>) => {
    for (const listener of listeners) {
      listener({ jsonrpc: "2.0", ...message });
    }
  };
  const ask = async (method: string, params: Record<string, unknown>) => {
    const mine = `r${++id}`;
    say({ id: mine, method, params });
    for (let tries = 0; tries < 40; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const found = heard.find((message) => "id" in message && message.id === mine);
      if (found !== undefined) {
        return found as { result?: unknown; error?: { data?: { code?: string } } };
      }
    }
    throw new Error(`no answer to ${method}`);
  };
  return { display, heard, say, ask, memory };
}

describe("8: a new page on the transport follows nothing the last one did", () => {
  test("another page of the set, or a repeat handshake, ends the watches", async () => {
    const t = show(
      presets.inlineWidget({ runtime: "1", capabilities: { db: {} } }),
      declared({ db: {} }),
      viewer("interact"),
    );
    const events = () =>
      t.heard.filter((each) => "method" in each && each.method === "porthole/event").length;
    await t.ask("ui/initialize", {});
    await t.ask("porthole/call", {
      capability: "db",
      method: "watch",
      args: { path: "n/a" },
      watch: "w1",
    });
    await t.ask("porthole/call", {
      capability: "db",
      method: "set",
      args: { path: "n/a", data: { v: 1 } },
    });
    const before = events();
    expect(before).toBe(2);
    t.say({ method: "porthole/navigating", params: { url: "https://x/next.html" } });
    await t.ask("porthole/call", {
      capability: "db",
      method: "set",
      args: { path: "n/a", data: { v: 2 }, ifVersion: 1 },
    });
    expect(events()).toBe(before);
    // The new page may use the same id again.
    expect(
      (
        await t.ask("porthole/call", {
          capability: "db",
          method: "watch",
          args: { path: "n/a" },
          watch: "w1",
        })
      ).error,
    ).toBeUndefined();
    await t.ask("ui/initialize", {});
    await t.ask("porthole/call", {
      capability: "db",
      method: "set",
      args: { path: "n/a", data: { v: 3 }, ifVersion: 2 },
    });
    expect(events()).toBe(before + 1);
    t.display.destroy();
  });

  test("the shell's watch ids are random", () => {
    const plan = shellPlan(presets.inlineWidget({ runtime: "1", capabilities: { db: {} } }));
    const runtimeText = composedRuntime(plan!);
    expect(runtimeText).toContain("crypto.getRandomValues(bytes)");
    expect(runtimeText).not.toContain("nextWatch++");
  });
});

describe("9: what an upload may become", () => {
  test("code-typed names refused where people who interact upload; trusted only for an admin where code runs", async () => {
    const open = runtime({ assets: { levels: { upload: "interact" } } });
    const one = bridgeOf(open, {
      declaration: declared({ assets: {} }),
      viewer: viewer("admin"),
      confirm: false,
    });
    for (const name of ["a.js", "a.mjs", "a.css", "a.wasm"]) {
      expect(
        await one.bridge.call("assets", { op: "upload", name, base64: "aGk=" }),
        name,
      ).toMatchObject({
        refusal: "invalid",
      });
    }
    expect(
      (await one.bridge.call("assets", { op: "upload", name: "a.png", base64: "aGk=" })).ok,
    ).toBe(true);
    const admins = runtime({ assets: {} });
    const admin = bridgeOf(admins, {
      declaration: declared({ assets: {} }),
      viewer: viewer("admin"),
    });
    await admin.bridge.call("assets", { op: "upload", name: "a.js", base64: "aGk=" });
    await admin.bridge.call("assets", { op: "upload", name: "b.png", base64: "aGk=" });
    expect([...admin.memory.assets.values()].map((each) => [each.name, each.trusted])).toEqual([
      ["a.js", true],
      ["b.png", false],
    ]);
    const words = compile(open).guide(["interactive"]);
    expect(words).not.toContain("never run");
    expect(words).toContain("no scripts or stylesheets");
  });
});

describe("10: under a runtime a mount says what its page declared", () => {
  test("required; null for a page from before 0.7; none without a runtime", () => {
    const { platform } = {
      platform: {
        name: "x",
        createSurface: () => {
          throw new Error("unused");
        },
      } as PlatformHost,
    };
    const host = createHost(runtime({ db: {} }), {
      handlers: memoryRuntime().handlers,
      platform,
      locator: { locate: () => Promise.reject(new Error("unused")) },
    });
    const shown = { scope: "s", document: { kind: "artifact" as const, id: "a", version: "1" } };
    expect(() =>
      host.mount(container, { displayId: "d", title: "t", scheme: "light", instance: shown }),
    ).toThrow(/needs MountOptions\.declaration/u);
    const plain = createHost(presets.artifact({ isolation: "domain", contentOrigins: ORIGINS }), {
      platform,
      locator: { locate: () => Promise.reject(new Error("unused")) },
    });
    expect(() =>
      plain.mount(container, {
        displayId: "d",
        title: "t",
        scheme: "light",
        instance: { scope: "s", document: { kind: "artifact", id: "a", version: "1" } },
        declaration: declared({}),
      }),
    ).toThrow(/needs config\.runtime/u);
  });
});

describe("11: the low ones", () => {
  test("a prefix vouches for no name that could leave it", () => {
    for (const name of [
      "ui://app/tasks/../secrets",
      "ui://app/tasks/%2e%2e/x",
      "ui://app/tasks/a/./b",
      "ui://app/tasks/a\\b",
    ]) {
      expect(declaredMatch(["ui://app/tasks/*"], name), name).toBe(false);
    }
    expect(declaredMatch(["ui://app/tasks/*"], "ui://app/tasks/1")).toBe(true);
  });

  test("a published __proto__ path is a path; db batches name a path once", async () => {
    const config = runtime({ artifact: {} });
    const handlers: CapabilityHandlers = {
      ...memoryRuntime().handlers,
      artifact: (args) => {
        if (args.op !== "publish") {
          throw new Error("unexpected");
        }
        expect(Object.getPrototypeOf(args.files)).toBeNull();
        expect(Object.keys(args.files)).toEqual(["__proto__"]);
        return { version: "v" };
      },
    };
    const { bridge } = bridgeOf(config, {
      declaration: declared({ artifact: {} }),
      viewer: viewer("admin"),
      handlers,
    });
    const files = JSON.parse('{"__proto__": {"text": "x"}}') as Record<string, unknown>;
    expect((await bridge.call("artifact", { op: "publish", base: "b", files })).ok).toBe(true);
    expect(
      parseDbRequest({
        op: "batch",
        writes: [
          { op: "set", path: "n/z", data: {}, ifVersion: 0 },
          { op: "set", path: "n/z", data: {}, ifVersion: 0 },
        ],
      }),
    ).toBeNull();
  });

  test("the reference store: every write to an existing document names its version; a watch caps as a query", async () => {
    const config = runtime({ db: {} });
    const { bridge } = bridgeOf(config, {
      declaration: declared({ db: {} }),
      viewer: viewer("interact"),
    });
    await bridge.call("db", { op: "set", path: "n/a", data: { a: 1 } });
    expect(await bridge.call("db", { op: "update", path: "n/a", data: { b: 2 } })).toMatchObject({
      reason: { code: "conflict" },
    });
    expect(await bridge.call("db", { op: "delete", path: "n/a" })).toMatchObject({
      reason: { code: "conflict" },
    });
    for (let start = 0; start < 600; start += 50) {
      await bridge.call("db", {
        op: "batch",
        writes: Array.from({ length: 50 }, (_, index) => ({
          op: "set",
          path: `big/d${start + index}`,
          data: {},
        })),
      });
    }
    let docs = 0;
    await bridge.call(
      "db",
      { op: "watch", path: "big" },
      {
        subscription: {
          changed: (state) => (docs = (state as { docs: unknown[] }).docs.length),
          signal: new AbortController().signal,
        },
      },
    );
    expect(docs).toBe(500);
  });

  test("a publish whose merged set loses its entry is refused by the reference host", async () => {
    const config = runtime({ artifact: {} });
    const { bridge } = bridgeOf(config, {
      declaration: declared({ artifact: {} }),
      viewer: viewer("admin"),
    });
    expect(
      await bridge.call("artifact", {
        op: "publish",
        base: "ver_1",
        files: { "index.html": null },
      }),
    ).toMatchObject({
      reason: { code: "not_allowed" },
    });
  });
});

describe("12: back compatibility", () => {
  test("a 0.6 config's own topic named capabilities stays its own", () => {
    const config = presets.artifact({ guide: { topics: { capabilities: "Our own words." } } });
    expect(compile(config).guide(["capabilities"])).toBe("Our own words.");
    expect(() => runtime({}, { guide: { topics: { capabilities: "x" } } })).toThrow(ConfigError);
  });
});

describe("(c) a version is shown with what it and the artifact both declare", () => {
  test("the intersection, at the stricter levels and rules, the narrower names, the version's pin", () => {
    const version = declared({
      db: { rules: { votes: { write: "admin" } }, levels: { set: "admin" } },
      data: { resources: ["app://tasks/*", "app://mail/1"] },
      artifact: {},
    });
    const current = declared({
      db: { rules: { votes: { read: "interact" }, notes: { write: "admin" } } },
      data: { resources: ["app://tasks/1"] },
      user: {},
    });
    expect(intersectDeclarations(version, current)).toEqual({
      capabilities: {
        db: {
          levels: { set: "admin" },
          rules: { votes: { read: "interact", write: "admin" }, notes: { write: "admin" } },
        },
        data: { resources: ["app://tasks/1"] },
      },
      runtime: "1",
    });
  });
});

describe("pseudonyms per artifact (P087)", () => {
  test("stable per artifact and person, different across artifacts, one path segment", () => {
    const secret = new Uint8Array(32).fill(7);
    const a = pseudonymFor(secret, "art_1", "user_1");
    expect(a).toMatch(/^[a-z2-7]{26}$/u);
    expect(pseudonymFor(secret, "art_1", "user_1")).toBe(a);
    expect(pseudonymFor(secret, "art_2", "user_1")).not.toBe(a);
    expect(parseViewer({ level: "view", id: a })).toEqual({ level: "view", id: a });
    expect(() => pseudonymFor(new Uint8Array(8), "a", "b")).toThrow(TypeError);
  });

  test("runtimeCalls is per page (exported for hosts with their own adapter)", () => {
    expect(typeof runtimeCalls).toBe("function");
  });
});
