import { createHash } from "node:crypto";
import vm from "node:vm";
import { describe, expect, test } from "vitest";
import { compile, presets } from "../src/index.ts";
import {
  SHELL_STORAGE_CLEAR_METHOD,
  SHELL_STORAGE_PORT_METHOD,
  SHELL_STORE_CLEAR_METHOD,
  SHELL_STORE_PORT_METHOD,
} from "../src/isolation/types.ts";
import { createServer, nestedLabelOf } from "../src/server/index.ts";
import {
  FORGET_SCRIPT,
  forgetResponse,
  nestedShellCsp,
  STORE_PREFIX,
  storeResponse,
} from "../src/server/nested.ts";
import { FRAME_SHELL_RUNTIME, frameShellScript } from "../src/shell/frame.ts";
import { SHELL_RUNTIME } from "../src/shell/runtime.ts";
import {
  STORE_MAX_KEYS,
  STORE_MAX_UNITS,
  STORE_RUNTIME,
  storeDocument,
  storeScript,
} from "../src/shell/store.ts";

/**
 * A nested page's kept storage (P149): the config that asks for it, the store's document and its
 * script against a stub origin, the shell's hand-over, and what `/server` answers at the store's
 * and the forget addresses. The browsers hold the rest (`leak/served/nested-storage.spec.ts`).
 */

const SITE = "example-usercontent.com";
const HOST = "https://app.example.com";
const SHELL = `https://porthole-${"a".repeat(24)}.${SITE}`;
const SCOPE = `https://a-x.${SITE}`;
const kept = () =>
  presets.artifact({
    isolation: "domain",
    contentOrigins: [`https://*.${SITE}`],
    nested: true,
    storage: { scope: "this artifact, across its versions" },
  });
const hashOf = (script: string): string =>
  `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
const inlineScriptOf = (html: string): string =>
  /<script>([\s\S]*)<\/script>/u.exec(html)?.[1] ?? "";

describe("config and plan", () => {
  test("a nested page may keep its own scope's storage; its plan says kept, and the manual says what is and isn't", () => {
    const compiled = compile(kept());
    expect(compiled.shell?.storage).toBe("kept");
    expect(compiled.guide()).toMatch(
      /localStorage is kept for this artifact, across its versions/u,
    );
    expect(compiled.guide()).toMatch(/no IndexedDB, Cache API or cookie/u);
    expect(compiled.guide()).not.toMatch(/State isn't saved/u);
  });

  test("the names each side writes are the ones in the shell's namespace", () => {
    expect(FRAME_SHELL_RUNTIME).toContain('PREFIX + "store-port"');
    expect(FRAME_SHELL_RUNTIME).toContain('PREFIX + "storage-port"');
    expect(FRAME_SHELL_RUNTIME).toContain('PREFIX + "storage-clear"');
    expect(FRAME_SHELL_RUNTIME).toContain('PREFIX + "store-clear"');
    expect(STORE_RUNTIME).toContain(`"${SHELL_STORE_PORT_METHOD}"`);
    expect(STORE_RUNTIME).toContain(`"${SHELL_STORE_CLEAR_METHOD}"`);
    expect(SHELL_RUNTIME).toContain(`data.method === "${SHELL_STORAGE_PORT_METHOD}"`);
    expect(SHELL_STORAGE_CLEAR_METHOD).toBe("porthole/shell/storage-clear");
    // The caps, the same number on both sides.
    expect(SHELL_RUNTIME).toContain(`const MAX_UNITS = ${STORE_MAX_UNITS};`);
    expect(SHELL_RUNTIME).toContain(`const MAX_KEYS = ${STORE_MAX_KEYS};`);
  });
});

/** The store's script in a stub page on the scope's origin: its `localStorage`, its parent, its ports. */
function storeAt(options: { storage?: Map<string, string> | null; shell?: string } = {}) {
  // What the origin holds; `storage: null` is a browser that gives a framed page none.
  const items = options.storage ?? new Map<string, string>();
  const none = options.storage === null;
  const heard: ((event: unknown) => void)[] = [];
  const onStorage: ((event: unknown) => void)[] = [];
  const parent = {};
  const storage = none
    ? null
    : {
        get length() {
          return items.size;
        },
        key: (index: number) => Array.from(items.keys())[index] ?? null,
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
        clear: () => items.clear(),
      };
  const context: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      (type === "message" ? heard : type === "storage" ? onStorage : []).push(listener);
    },
  };
  Object.defineProperty(context, "localStorage", {
    get() {
      if (storage === null) {
        throw new Error("no storage here");
      }
      return storage;
    },
  });
  context.window = context;
  vm.runInNewContext(storeScript({ shell: options.shell ?? SHELL }), context);
  /** A port as the store sees it: what it said on it, and a way to say something to it. */
  const port = () => {
    const said: unknown[] = [];
    const end = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      closed: false,
      postMessage: (message: unknown) => void said.push(JSON.parse(JSON.stringify(message))),
      close() {
        end.closed = true;
      },
    };
    return { end, said, tell: (data: unknown) => end.onmessage?.({ data }) };
  };
  const post = (
    data: unknown,
    more: { origin?: string; source?: unknown; trusted?: boolean; ports?: unknown[] } = {},
  ) => {
    for (const listener of heard) {
      listener({
        isTrusted: more.trusted ?? true,
        source: more.source ?? parent,
        origin: more.origin ?? SHELL,
        data,
        ports: more.ports ?? [],
      });
    }
  };
  const give = (more: Parameters<typeof post>[1] = {}) => {
    const made = port();
    post({ jsonrpc: "2.0", method: SHELL_STORE_PORT_METHOD }, { ...more, ports: [made.end] });
    return made;
  };
  return { items, post, give, onStorage, storage };
}

describe("the store's script", () => {
  test("it answers its own shell alone: its parent, at that origin, in the browser's own message, with one port", () => {
    const refused = [
      { origin: HOST },
      { origin: `https://porthole-${"b".repeat(24)}.${SITE}` },
      { source: {} },
      { trusted: false },
    ];
    for (const more of refused) {
      const { give } = storeAt({ storage: new Map([["k", "v"]]) });
      const port = give(more);
      port.tell({ ask: 1 });
      expect(port.said, JSON.stringify(more)).toEqual([]);
    }
    const { post, give } = storeAt({ storage: new Map([["k", "v"]]) });
    // Two ports, or none: not the shell's message.
    post({ jsonrpc: "2.0", method: SHELL_STORE_PORT_METHOD }, { ports: [{}, {}] });
    const port = give();
    port.tell({ ask: 1 });
    expect(port.said).toEqual([{ keys: [["k", "v"]], kept: true }]);
  });

  test("a new port from its shell replaces the one before, which hears nothing more", () => {
    const { give } = storeAt({ storage: new Map([["k", "v"]]) });
    const first = give();
    const second = give();
    expect(first.end.closed).toBe(true);
    second.tell({ ask: 1 });
    expect(second.said).toHaveLength(1);
    expect(first.said).toEqual([]);
  });

  test("set, remove and clear are strings into the origin's storage, and nothing else is anything", () => {
    const { give, items } = storeAt();
    const port = give();
    port.tell({ set: ["a", "1"] });
    port.tell({ set: ["__proto__", "p"] });
    port.tell({ set: ["hasOwnProperty", "h"] });
    for (const bad of [
      { set: ["a", 2] },
      { set: [3, "x"] },
      { set: ["only"] },
      { set: "a" },
      { remove: 4 },
      { clear: true },
      { ask: true },
      { refresh: 1 },
      null,
      "set",
    ]) {
      port.tell(bad);
    }
    expect(Array.from(items)).toEqual([
      ["a", "1"],
      ["__proto__", "p"],
      ["hasOwnProperty", "h"],
    ]);
    port.tell({ ask: 1 });
    expect(port.said).toEqual([
      {
        keys: [
          ["a", "1"],
          ["__proto__", "p"],
          ["hasOwnProperty", "h"],
        ],
        kept: true,
      },
    ]);
    port.tell({ remove: "__proto__" });
    expect(items.has("__proto__")).toBe(false);
    port.tell({ clear: 1 });
    expect(items.size).toBe(0);
  });

  test("it never grows the origin past the caps, by its own count; what is already past them can shrink", () => {
    const { give, items } = storeAt();
    const port = give();
    port.tell({ set: ["big", "x".repeat(STORE_MAX_UNITS)] });
    expect(items.has("big"), "one unit past: the key's own length").toBe(false);
    port.tell({ set: ["big", "x".repeat(STORE_MAX_UNITS - 3)] });
    expect(items.get("big")?.length).toBe(STORE_MAX_UNITS - 3);
    port.tell({ set: ["more", ""] });
    expect(items.has("more")).toBe(false);
    port.tell({ set: ["big", "small"] });
    expect(items.get("big")).toBe("small");
    for (let i = 0; i < STORE_MAX_KEYS + 10; i += 1) {
      port.tell({ set: [`n${i}`, ""] });
    }
    expect(items.size).toBe(STORE_MAX_KEYS);
    // An origin a served page already filled past the cap: readable, shrinkable, not growable.
    const full = storeAt({ storage: new Map([["old", "y".repeat(STORE_MAX_UNITS * 2)]]) });
    const other = full.give();
    other.tell({ set: ["old", "y".repeat(STORE_MAX_UNITS * 2 + 1)] });
    expect(full.items.get("old")?.length).toBe(STORE_MAX_UNITS * 2);
    other.tell({ set: ["new", "z"] });
    expect(full.items.has("new")).toBe(false);
    other.tell({ set: ["old", "y".repeat(STORE_MAX_UNITS + 5)] });
    expect(full.items.get("old")?.length).toBe(STORE_MAX_UNITS + 5);
  });

  test("the host's word to clear, from its shell alone; another tab's change is passed on", () => {
    const { give, post, items, onStorage, storage } = storeAt({ storage: new Map([["k", "v"]]) });
    const port = give();
    post({ jsonrpc: "2.0", method: SHELL_STORE_CLEAR_METHOD }, { origin: HOST });
    post({ jsonrpc: "2.0", method: SHELL_STORE_CLEAR_METHOD }, { trusted: false });
    expect(items.get("k")).toBe("v");
    post({ jsonrpc: "2.0", method: SHELL_STORE_CLEAR_METHOD });
    expect(items.size).toBe(0);
    expect(port.said).toEqual([{ cleared: 1 }]);
    for (const listener of onStorage) {
      listener({ storageArea: storage, key: "other", newValue: "tab" });
      listener({ storageArea: storage, key: "gone", newValue: null });
      listener({ storageArea: storage, key: null, newValue: null });
      listener({ storageArea: {}, key: "session", newValue: "x" });
    }
    expect(port.said.slice(1)).toEqual([
      { changed: ["other", "tab"] },
      { changed: ["gone", null] },
      { cleared: 1 },
    ]);
  });

  test("where the browser gives a framed page no storage, it says so and keeps nothing", () => {
    const { give } = storeAt({ storage: null });
    const port = give();
    port.tell({ ask: 1 });
    port.tell({ set: ["k", "v"] });
    expect(port.said).toEqual([]);
  });

  test("its script is made for one shell's origin, a real one", () => {
    expect(storeScript({ shell: SHELL })).toContain(`"shell":"${SHELL}"`);
    expect(() => storeScript({ shell: "https://a.example; x" })).toThrow(/shell/u);
    expect(storeDocument("X")).toContain("<script>X</script>");
  });
});

describe("what a content origin answers", () => {
  test("the store's answer: its one script by its hash, framed by its shell and the pages above it, never cached", async () => {
    const answer = storeResponse({ shell: SHELL, hostOrigins: [HOST] });
    const csp = answer.headers.get("content-security-policy") ?? "";
    const script = inlineScriptOf(await answer.text());
    expect(script).toBe(storeScript({ shell: SHELL }));
    expect(csp).toBe(
      `default-src 'none'; script-src ${hashOf(script)}; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin; frame-ancestors ${HOST} ${SHELL}`,
    );
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("clear-site-data")).toBeNull();
    expect(() => storeResponse({ shell: SCOPE, hostOrigins: [HOST] })).toThrow(/own label/u);
    expect(() => storeResponse({ shell: SHELL, hostOrigins: ["https://a.example:0"] })).toThrow(
      /hostOrigins/u,
    );
  });

  test("the forget address's answer, and it alone, says to drop the origin's storage: the header, and the document's own script", async () => {
    const answer = forgetResponse({ hostOrigins: [HOST] });
    expect(answer.headers.get("clear-site-data")).toBe('"storage"');
    const csp = answer.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`script-src ${hashOf(FORGET_SCRIPT)}`);
    expect(csp).toContain(`frame-ancestors ${HOST}`);
    expect(csp).toContain("sandbox allow-scripts allow-same-origin;");
    expect(inlineScriptOf(await answer.text())).toBe(FORGET_SCRIPT);
    expect(FORGET_SCRIPT).toContain("localStorage.clear()");
  });

  test("the shell's CSP frames the store's prefix on the scope's origin only where there is one", () => {
    expect(nestedShellCsp("0", SHELL, [HOST])).toContain(`frame-src ${SHELL}/__porthole/f/;`);
    expect(nestedShellCsp("0", SHELL, [HOST], [], SCOPE)).toContain(
      `frame-src ${SHELL}/__porthole/f/ ${SCOPE}${STORE_PREFIX};`,
    );
    expect(() => nestedShellCsp("0", SHELL, [HOST], [], SHELL)).toThrow(/store/u);
  });

  test("the shell's script takes a store's address under its prefix, on another origin than its own", () => {
    const page = `${SHELL}/__porthole/f/abc/`;
    const script = frameShellScript({ origins: [HOST], page, store: `${SCOPE}${STORE_PREFIX}tok` });
    expect(script).toContain(`"store":"${SCOPE}${STORE_PREFIX}tok"`);
    // The store's frame has its own origin and scripts, and nothing else a frame may do.
    expect(FRAME_SHELL_RUNTIME).toContain(
      'storeFrame.setAttribute("sandbox", "allow-scripts allow-same-origin");',
    );
    expect(frameShellScript({ origins: [HOST], page })).not.toContain('"store"');
    for (const store of [
      `${SHELL}${STORE_PREFIX}tok`,
      `${SCOPE}/elsewhere/tok`,
      `${SCOPE}${STORE_PREFIX}tok?x=1`,
      "not a url",
    ]) {
      expect(() => frameShellScript({ origins: [HOST], page, store }), store).toThrow(/store/u);
    }
  });
});

describe("/server", () => {
  const server = (config = kept()) =>
    createServer({
      content: { domain: SITE, scheme: "https" },
      secret: new Uint8Array(32).fill(7),
      hostOrigins: [HOST],
      configs: { artifact: config },
      artifacts: { get: () => Promise.resolve({ html: "<!doctype html><p>one page</p>" }) },
    });
  const ask = (url: string, method = "GET") =>
    new Request(url, {
      method,
      headers: {
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
    });
  const shellOf = async (porthole: ReturnType<typeof server>, scope: string) => {
    const location = await porthole.issue(
      { scope, document: { kind: "artifact", id: "page", version: "1" } },
      { viewer: "ada" },
    );
    const shell = await porthole.handle(ask(location.url));
    return { location, shell, html: (await shell?.clone().text()) ?? "" };
  };

  test("a page that keeps storage: its shell names a store on the scope's own origin and may frame it; one that keeps none names none", async () => {
    const porthole = server();
    const { location, shell, html } = await shellOf(porthole, "one");
    const store = /"store":"([^"]+)"/u.exec(html)?.[1] ?? "";
    const scope = porthole.originFor("one");
    expect(scope).not.toBe(location.origin);
    expect(store.startsWith(`${scope}${STORE_PREFIX}`)).toBe(true);
    expect(shell?.headers.get("content-security-policy")).toContain(` ${scope}${STORE_PREFIX};`);
    // Asked for, it is the store's document, for this shell.
    const answer = await porthole.handle(ask(store));
    expect(answer?.status).toBe(200);
    expect(inlineScriptOf((await answer?.text()) ?? "")).toBe(
      storeScript({ shell: location.origin }),
    );
    expect(answer?.headers.get("content-security-policy")).toContain(
      `frame-ancestors ${HOST} ${location.origin}`,
    );
    const plain = server(
      presets.artifact({
        isolation: "domain",
        contentOrigins: [`https://*.${SITE}`],
        nested: true,
      }),
    );
    const without = await shellOf(plain, "one");
    expect(without.html).not.toContain('"store"');
    expect(without.shell?.headers.get("content-security-policy")).not.toContain(STORE_PREFIX);
  });

  test("the store's address opens for its own scope's shell alone: not on another scope's origin, not with a files token, not by another method", async () => {
    const porthole = server();
    const one = await shellOf(porthole, "one");
    const store = new URL(/"store":"([^"]+)"/u.exec(one.html)?.[1] ?? "");
    const other = porthole.originFor("two");
    const moved = await porthole.handle(ask(`${other}${store.pathname}`));
    expect(moved?.status).toBe(404);
    const files = /"page":"[^"]+\/__porthole\/f\/([A-Za-z0-9_-]+)\//u.exec(one.html)?.[1] ?? "";
    expect(files.length).toBeGreaterThan(40);
    const wrongToken = await porthole.handle(ask(`${store.origin}${STORE_PREFIX}${files}`));
    expect(wrongToken?.status).toBe(404);
    const posted = await porthole.handle(ask(store.href, "POST"));
    expect(posted?.status).toBe(404);
    // And the store's own token opens no files.
    const token = store.pathname.slice(STORE_PREFIX.length);
    const asFiles = await porthole.handle(ask(`${one.location.origin}/__porthole/f/${token}/`));
    expect(asFiles?.status).not.toBe(200);
    for (const answer of [moved, wrongToken, posted, asFiles]) {
      expect(answer?.headers.get("clear-site-data")).toBeNull();
    }
  });

  test("forgetStorage: an address on the scope's own origin, good once, the only answer with the header; its ticket opens nothing else", async () => {
    const porthole = server();
    const address = await porthole.forgetStorage("one");
    const scope = porthole.originFor("one");
    expect(address.startsWith(`${scope}/__porthole/forget/`)).toBe(true);
    expect(new URL(address).hostname.startsWith(nestedLabelOf("x").slice(0, 9))).toBe(false);
    // Not on another scope's origin, and trying there spends nothing of it.
    const elsewhere = await porthole.handle(
      ask(`${porthole.originFor("two")}${new URL(address).pathname}`),
    );
    expect(elsewhere?.status).toBe(404);
    expect(elsewhere?.headers.get("clear-site-data")).toBeNull();
    const again = await porthole.forgetStorage("one");
    const first = await porthole.handle(ask(again));
    expect(first?.status).toBe(200);
    expect(first?.headers.get("clear-site-data")).toBe('"storage"');
    const second = await porthole.handle(ask(again));
    expect(second?.status).toBe(404);
    expect(second?.headers.get("clear-site-data")).toBeNull();
    // As a document's ticket it opens nothing, and is not spent by the try.
    const third = await porthole.forgetStorage("one");
    const ticket = new URL(third).pathname.split("/").at(-1) ?? "";
    const location = await porthole.issue(
      { scope: "one", document: { kind: "artifact", id: "page", version: "1" } },
      { viewer: "ada" },
    );
    const asTicket = new URL(location.url);
    asTicket.searchParams.set("ticket", ticket);
    const refused = await porthole.handle(ask(asTicket.href));
    expect(refused?.status).not.toBe(200);
    expect(refused?.headers.get("clear-site-data")).toBeNull();
    expect((await porthole.handle(ask(third)))?.status).toBe(200);
    // And a document's ticket brought to the forget address is not spent there: its own address
    // still opens.
    const real = new URL(location.url).searchParams.get("ticket") ?? "";
    expect(real.length).toBeGreaterThan(10);
    const misplaced = await porthole.handle(ask(`${scope}/__porthole/forget/${real}`));
    expect(misplaced?.status).toBe(404);
    expect((await porthole.handle(ask(location.url)))?.status).toBe(200);
    await expect(porthole.forgetStorage("")).rejects.toThrow(/scope/u);
  });
});
