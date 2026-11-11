import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { presets } from "../src/index.ts";
import type { InstanceRef } from "../src/isolation/types.ts";
import {
  FRAME_SHELL_RUNTIME,
  frameShellScript,
  STRICT_FRAME_SHELL_RUNTIME,
} from "../src/shell/frame.ts";
import { includesOrigin, normalOrigin } from "../src/isolation/served.ts";
import {
  createContentHost,
  createServer,
  doorResponse,
  doorStatusResponse,
  nestedLabelOf,
  nestedShellCsp,
  nestedShellResponse,
  statusPage,
  type ServerOptions,
} from "../src/server/index.ts";
import {
  ENTER_SCRIPT_PATH,
  pageScript,
  STATUS_SCRIPT_PATH,
  STRICT_ENTER_SCRIPT_PATH,
  STRICT_STATUS_SCRIPT_PATH,
} from "../src/server/pages.ts";
import { compile } from "../src/compile/compile.ts";
import { ANNOTATE_RUNTIME } from "../src/shell/annotate.ts";
import { FIND_RUNTIME } from "../src/shell/find.ts";
import { LEGACY_GLOBALS_RUNTIME } from "../src/shell/legacy.ts";
import { SHELL_RUNTIME } from "../src/shell/runtime.ts";
import { USE_RUNTIME } from "../src/shell/use.ts";
import { FRAME_STATUS_METHOD } from "../src/isolation/types.ts";

/**
 * `framedBy` (P141): an outer page's origins that may be an ancestor of every frame a host shows,
 * above the host's own page. They are in every `frame-ancestors` Porthole sends and nowhere else:
 * never a host origin a frame hears or tells, never in a page's `data-porthole-hosts` or a shell's
 * plan. Where they are set, a page or a nested page's shell says `*` (a desktop scheme among the
 * host origins) only to a parent the engine names as a host origin, never to an outer page.
 */

const secret = new Uint8Array(32).fill(7);
const HOST = "https://app.example.com";
const DESKTOP = "ferry://app";
const DECK = "https://deck.example.net";
const DOMAIN = "example-usercontent.com";
const CONTENT = `https://*.${DOMAIN}`;

const encode = (text: string) => new TextEncoder().encode(text);
const files: Record<string, string> = {
  "index.html": `<!doctype html><html><head><script src="./app.js"></script></head><body>files</body></html>`,
  "app.js": "window.ran = true;",
  "notes.txt": "hi",
};
const fileSet = {
  files: Object.fromEntries(
    Object.entries(files).map(([name, body]) => [
      name,
      { size: encode(body).byteLength, sha256: "", type: "text/plain" },
    ]),
  ),
  read: (name: string) =>
    Promise.resolve(files[name] === undefined ? null : encode(files[name] ?? "")),
};

const configs = {
  inlineWidget: presets.inlineWidget({ isolation: "domain", contentOrigins: [CONTENT] }),
  artifact: presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] }),
  mcpApp: presets.mcpApp({ isolation: "domain", contentOrigins: [CONTENT] }),
  url: presets.url({ contentOrigins: [CONTENT] }),
  artifactFrames: presets.artifact({
    isolation: "domain",
    contentOrigins: [CONTENT],
    nestedFrames: "own",
  }),
  artifactNested: presets.artifact({
    isolation: "domain",
    contentOrigins: [CONTENT],
    nested: true,
  }),
};

function server(extra: Partial<ServerOptions> = {}) {
  return createServer({
    content: { domain: DOMAIN, scheme: "https" },
    secret,
    hostOrigins: [HOST, DESKTOP],
    framedBy: [DECK],
    configs,
    artifacts: {
      get: (id) =>
        Promise.resolve(
          id === "set" ? fileSet : { html: "<!doctype html><html><body><p>one</p></body></html>" },
        ),
    },
    upstream: () => new Response("<!doctype html><p>app</p>", { headers: { "x-app": "1" } }),
    ...extra,
  });
}

const ask = (url: string, dest = "iframe", headers: Record<string, string> = {}) =>
  new Request(url, {
    headers: { "sec-fetch-dest": dest, "sec-fetch-site": "cross-site", ...headers },
  });

const cookieOf = (response: Response): string =>
  (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

/** The `frame-ancestors` sources of every policy a response carries (null: none names it). */
function ancestorsOf(response: Response): string[] | null {
  const policies = (response.headers.get("content-security-policy") ?? "")
    .split(/[;,]/u)
    .map((each) => each.trim())
    .filter((each) => each.startsWith("frame-ancestors "));
  return policies.length === 0 ? null : policies.flatMap((each) => each.split(/\s+/u).slice(1));
}

/**
 * Every kind of answer `/server` frames, under one `framedBy`: a shell, an artifact page, a page of
 * a file set and its files, a page's own frames, a nested page's shell, page and files, an MCP
 * Apps proxy, a door and a used door, a url-mode app's entry page and its answers, the 401, 404
 * and renew answers.
 */
async function everyAnswer(porthole: ReturnType<typeof server>) {
  const answers: { readonly name: string; readonly response: Response }[] = [];
  const keep = async (name: string, response: Response | null) => {
    expect(response, name).not.toBeNull();
    answers.push({ name, response: response! });
    return response!;
  };
  const shellAt: InstanceRef = { scope: "s1", document: { kind: "shell", preset: "inlineWidget" } };
  const shell = await porthole.issue(shellAt, { viewer: "v" });
  const shown = await keep("shell", await porthole.handle(ask(shell.url)));
  expect(shown.status).toBe(200);
  await keep("shell's ticket used", await porthole.handle(ask(shell.url)));
  await keep("not found", await porthole.handle(ask(`${shell.origin}/nothing/here`)));
  if (shell.door !== undefined) {
    await keep("door", await porthole.handle(ask(shell.door.url)));
    await keep("door used", await porthole.handle(ask(shell.door.url)));
  }
  const page = await porthole.issue(
    { scope: "s2", document: { kind: "artifact", id: "page", version: "1" } },
    { viewer: "v" },
  );
  await keep("artifact page", await porthole.handle(ask(page.url)));
  const proxy = await porthole.issue(
    { scope: "s3", document: { kind: "mcp-proxy" } },
    { viewer: "v" },
  );
  await keep("mcp app proxy", await porthole.handle(ask(proxy.url)));
  for (const [scope, config] of [
    ["set-1", "artifact"],
    ["set-2", "artifactFrames"],
  ] as const) {
    const set = await porthole.issue(
      { scope, document: { kind: "artifact", id: "set", version: "1", preset: config } },
      { viewer: "v" },
    );
    const entry = await keep(`${config}: a file set's ticket`, await porthole.handle(ask(set.url)));
    const html = await entry.clone().text();
    const base = /"base":"([^"]+)"/u.exec(html)?.[1];
    expect(base, `${config}: the set's sealed base`).toBeDefined();
    const at = new URL(base!, set.origin).href;
    await keep(`${config}: its page at its base`, await porthole.handle(ask(at)));
    await keep(`${config}: its script`, await porthole.handle(ask(`${at}app.js`, "script")));
    await keep(`${config}: a text file`, await porthole.handle(ask(`${at}notes.txt`, "empty")));
    await keep(
      `${config}: a renewal from elsewhere`,
      await porthole.handle(ask(`${at}__porthole/renew`, "empty")),
    );
  }
  const nested = await porthole.issue(
    {
      scope: "n1",
      document: { kind: "artifact", id: "set", version: "1", preset: "artifactNested" },
    },
    { viewer: "v" },
  );
  const nestedShell = await keep("nested shell", await porthole.handle(ask(nested.url)));
  const nestedPage = /"page":"([^"]+)"/u.exec(await nestedShell.clone().text())?.[1] ?? "";
  expect(nestedPage).toContain("/__porthole/f/");
  await keep("nested page", await porthole.handle(ask(nestedPage)));
  await keep(
    "nested script",
    await porthole.handle(ask(new URL("app.js", nestedPage).href, "script")),
  );
  await keep(
    "nested page, its access ended",
    await porthole.handle(ask(nestedPage.replace(/\/f\/[^/]+\//u, "/f/AAAA/"))),
  );
  const app = await porthole.issue(
    { scope: "u1", document: { kind: "external", url: "https://app.test/landing" } },
    { viewer: "v" },
  );
  const entered = await keep("url mode: the entry page", await porthole.handle(ask(app.url)));
  const cookie = cookieOf(entered);
  if (cookie !== "") {
    await keep(
      "url mode: the app's answer",
      await porthole.handle(ask(`${app.origin}/landing`, "iframe", { cookie })),
    );
  }
  return answers;
}

describe("framedBy is checked like a host origin (P141)", () => {
  const base = {
    content: { domain: DOMAIN, scheme: "https" as const },
    secret,
    hostOrigins: [HOST],
    configs: {},
  };

  it("takes exact https origins, and http on loopback", () => {
    expect(() => createServer({ ...base, framedBy: [DECK] })).not.toThrow();
    expect(() =>
      createServer({ ...base, framedBy: ["http://localhost:5173", "http://127.0.0.1:8080"] }),
    ).not.toThrow();
  });

  it("refuses a wildcard, a path, a keyword, a list, null, a desktop scheme and plain http", () => {
    for (const bad of [
      "https://*.example.net",
      "https://deck.example.net/",
      "https://deck.example.net/app",
      "https://Deck.example.net",
      "*",
      "'self'",
      "https://deck.example.net https://evil.example",
      "https://deck.example.net; script-src *",
      "null",
      "ferry://app",
      "http://deck.example.net",
      "",
    ]) {
      expect(() => createServer({ ...base, framedBy: [bad] }), bad).toThrow(/framedBy/u);
    }
  });

  it("refuses a host origin (it frames and talks already) and the content domain's site", () => {
    expect(() => createServer({ ...base, framedBy: [HOST] })).toThrow(/host origin already/u);
    expect(() => createServer({ ...base, framedBy: [`https://deck.${DOMAIN}`] })).toThrow(
      /same site/u,
    );
    expect(() => createServer({ ...base, framedBy: [`https://${DOMAIN}`] })).toThrow(/same site/u);
  });

  it("the helpers a content Worker of its own answers with check them too", () => {
    expect(() =>
      doorResponse({ hostOrigins: [HOST], framedBy: ["https://*.deck.example"] }),
    ).toThrow(/framedBy/u);
    expect(() =>
      statusPage({ status: 401, title: "t", detail: "d", hostOrigins: [HOST], framedBy: [HOST] }),
    ).toThrow(/host origin/u);
    expect(() => nestedShellCsp("1;", "https://porthole-x.example", [HOST], ["*"])).toThrow(
      /framedBy/u,
    );
  });
});

describe("framedBy's port and host are as a browser serializes them (P145, Ferryman's edges probe of 0.15.0)", () => {
  const hostOrigins = [HOST, "ferry://app"];
  const base = {
    content: { domain: DOMAIN, scheme: "https" as const },
    secret,
    hostOrigins,
    configs: {},
  };
  const kitWith = (framedBy: readonly string[]) =>
    createContentHost<null>({
      domain: DOMAIN,
      appOrigins: hostOrigins,
      framedBy,
      secret,
      configs: {},
      instance: () => null,
      access: () => null,
    });
  /** Every place that takes `framedBy`, each throwing or not for `origin`. */
  const takers: readonly (readonly [string, (origin: string) => unknown])[] = [
    ["createServer", (origin) => createServer({ ...base, framedBy: [origin] })],
    ["the host kit", (origin) => kitWith([origin])],
    [
      "statusPage",
      (origin) =>
        statusPage({ status: 404, title: "t", detail: "d", hostOrigins, framedBy: [origin] }),
    ],
    ["doorResponse", (origin) => doorResponse({ hostOrigins, framedBy: [origin] })],
    [
      "doorStatusResponse",
      (origin) =>
        doorStatusResponse({ hostOrigins, framedBy: [origin], status: 401, reason: "session" }),
    ],
    [
      "nestedShellCsp",
      (origin) => nestedShellCsp("1;", "https://porthole-x.example", hostOrigins, [origin]),
    ],
    [
      "frameShellScript",
      (origin) => frameShellScript({ ...PINNED_SHELL, origins: hostOrigins, framedBy: [origin] }),
    ],
  ];

  it.each([
    "https://deck.example.net:0",
    "https://deck.example.net:00",
    "https://deck.example.net:65536",
    "https://deck.example.net:99999",
    "https://deck.example.net:0443",
    "https://deck.example.net:08443",
    `${HOST}:0443`,
    "http://localhost:0",
    "http://127.0.0.1:65536",
    "https://0x7f.0.0.1",
    "https://0177.0.0.1",
    "https://127.1",
    "https://203.0.113.07",
  ])("refuses %s everywhere it is taken", (origin) => {
    for (const [name, take] of takers) {
      expect(() => take(origin), name).toThrow(/framedBy/u);
    }
  });

  it.each([
    // Refused before (P141, P144), and still.
    HOST,
    `${HOST}:443`,
    "https://deck.example.net.",
    "https://deck.example.net.:8443",
    "https://user@deck.example.net",
    "https://déck.example.net",
    "https://DECK.example.net",
    "https://deck.example.net/x",
    "http://deck.example.net",
    "ferry://App",
  ])("still refuses %s", (origin) => {
    for (const [name, take] of takers) {
      expect(() => take(origin), name).toThrow(/framedBy/u);
    }
  });

  it.each([
    "https://deck.example.net:1",
    "https://deck.example.net:8443",
    "https://deck.example.net:65535",
    // A default port: a browser drops it, and it is compared so (P144).
    "https://deck.example.net:443",
    "https://203.0.113.7",
    "http://localhost:5173",
    "http://127.0.0.1:8080",
    "http://[::1]:3000",
  ])("takes %s everywhere it is taken", (origin) => {
    for (const [name, take] of takers) {
      expect(() => take(origin), name).not.toThrow();
    }
  });

  it("a host origin's port is held the same way", () => {
    for (const origin of [`${HOST}:0`, `${HOST}:99999`, `${HOST}:0443`, "ferry://app:0"]) {
      expect(() => createServer({ ...base, hostOrigins: [origin] }), origin).toThrow(
        /hostOrigins/u,
      );
    }
    expect(() => createServer({ ...base, hostOrigins: [`${HOST}:8443`] })).not.toThrow();
  });

  it("embeds that isn't a boolean throws", () => {
    expect(() => createServer({ ...base, embeds: "true" as unknown as boolean })).toThrow(
      /embeds/u,
    );
  });
});

describe("framedBy is in every frame-ancestors, and nowhere else (P141)", () => {
  it("every answer that names frame-ancestors names the outer page after the host origins; none says it elsewhere", async () => {
    const answers = await everyAnswer(server());
    expect(answers.map(({ name }) => name)).toHaveLength(23);
    for (const { name, response } of answers) {
      const ancestors = ancestorsOf(response);
      if (ancestors !== null) {
        expect(ancestors, `${name}: frame-ancestors`).toContain(DECK);
        expect(ancestors.indexOf(HOST), `${name}: host origin before it`).toBeLessThan(
          ancestors.indexOf(DECK),
        );
      }
      for (const [header, value] of response.headers) {
        if (header !== "content-security-policy") {
          expect(value, `${name}: ${header}`).not.toContain("deck.example.net");
        }
      }
      // Not in a page's body: not in data-porthole-hosts, a shell's plan, or anything it says.
      const body = await response.text();
      expect(body, `${name}: body`).not.toContain("deck.example.net");
    }
    // Every framed document says who may frame it.
    const framed = answers.filter(({ response }) =>
      (response.headers.get("content-type") ?? "").startsWith("text/html"),
    );
    for (const { name, response } of framed) {
      expect(ancestorsOf(response), `${name}: has frame-ancestors`).not.toBeNull();
    }
  });

  it("without framedBy, nothing changes: frame-ancestors is the host origins, no page is strict", async () => {
    const answers = await everyAnswer(server({ framedBy: [] }));
    for (const { name, response } of answers) {
      const ancestors = ancestorsOf(response);
      if (ancestors !== null) {
        expect(ancestors, name).not.toContain(DECK);
      }
      const body = await response.text();
      expect(body, name).not.toContain("data-porthole-strict-parent");
      expect(body, name).not.toContain('"strictParent"');
    }
  });

  it("with framedBy, the pages that may say * are strict about their parent, and the shells' plans too", async () => {
    const answers = await everyAnswer(server());
    const strict = answers.filter(({ name }) =>
      [
        "shell's ticket used",
        "not found",
        "door",
        "door used",
        "url mode: the entry page",
      ].includes(name),
    );
    expect(strict.length).toBeGreaterThan(3);
    for (const { name, response } of strict) {
      expect(await response.text(), name).toContain("data-porthole-strict-parent");
    }
    const nested = answers.find(({ name }) => name === "nested shell");
    expect(await nested?.response.text()).toContain('"strictParent":true');
  });

  it("the helpers for a content Worker of its own: framedBy in frame-ancestors, the hosts alone told", async () => {
    for (const response of [
      doorResponse({ hostOrigins: [HOST], framedBy: [DECK] }),
      doorStatusResponse({ status: 401, reason: "session", hostOrigins: [HOST], framedBy: [DECK] }),
      statusPage({ status: 429, title: "t", detail: "d", hostOrigins: [HOST], framedBy: [DECK] }),
    ]) {
      expect(ancestorsOf(response)).toEqual([HOST, DECK]);
      const body = await response.text();
      expect(body).toContain(`data-porthole-hosts="[&#34;${HOST}&#34;]"`);
      expect(body).not.toContain("deck.example.net");
    }
    // The defaults are as before: the host origins alone.
    expect(ancestorsOf(doorResponse({ hostOrigins: [HOST] }))).toEqual([HOST]);
    const origin = `https://${nestedLabelOf("abc")}.${DOMAIN}`;
    const shell = nestedShellResponse(compile(configs.artifactNested), {
      origin,
      origins: [HOST],
      framedBy: [DECK],
      page: `${origin}/__porthole/f/x/`,
    });
    expect(ancestorsOf(shell)).toEqual([HOST, DECK]);
    const html = await shell.text();
    expect(html).toContain(`"origins":["${HOST}"]`);
    expect(html).not.toContain("deck.example.net");
  });
});

describe("an outer page as the parent is never told, nor heard (P141, negative control)", () => {
  /** Runs a page's status script in a frame whose parent the engine names as `parent`. */
  async function statusSaid(strict: boolean, parent: string | undefined) {
    const posted: string[] = [];
    const path = strict ? STRICT_STATUS_SCRIPT_PATH : STATUS_SCRIPT_PATH;
    runInNewContext((await pageScript(path)?.text()) ?? "", {
      window: {
        parent: {
          postMessage: (_message: unknown, origin: string) => {
            if (origin !== "*" && !/^https?:\/\/[^/]+$/u.test(origin)) {
              throw new SyntaxError(`Invalid target origin '${origin}'`);
            }
            posted.push(origin);
          },
        },
      },
      document: {
        querySelector: () => ({
          dataset: {
            portholeHosts: JSON.stringify([HOST, DESKTOP]),
            portholeReason: "session",
            portholeStatus: "401",
            ...(strict ? { portholeStrictParent: "" } : {}),
          },
        }),
      },
      location: parent === undefined ? {} : { ancestorOrigins: [parent] },
    });
    return posted;
  }

  it("a strict page says * only to a parent named as a host origin: never to the outer page, never unnamed", async () => {
    expect(await statusSaid(true, DESKTOP)).toEqual([HOST, "*"]);
    expect(await statusSaid(true, HOST)).toEqual([HOST]);
    expect(await statusSaid(true, DECK)).toEqual([HOST]);
    expect(await statusSaid(true, "null")).toEqual([HOST]);
    expect(await statusSaid(true, undefined)).toEqual([HOST]);
    // The control: without strictness (frame-ancestors the host origins alone), an outer page as
    // the parent would have heard * (were it framable), as an unnamed parent still does.
    expect(await statusSaid(false, DECK)).toEqual([HOST, "*"]);
    expect(await statusSaid(false, undefined)).toEqual([HOST, "*"]);
  });

  /** The nested page's shell's word to its host, with the engine naming `parent`. */
  function shellSaid(framedBy: readonly string[], parent: string | undefined, from: string) {
    const origin = `https://${nestedLabelOf("abc")}.${DOMAIN}`;
    const script = frameShellScript({
      origins: [HOST, DESKTOP],
      framedBy,
      page: `${origin}/__porthole/f/x/`,
    });
    const posted: string[] = [];
    const delivered: unknown[] = [];
    const listeners: ((event: unknown) => void)[] = [];
    const parentWindow = {
      postMessage: (_message: unknown, target: string) => {
        if (target !== "*" && !/^https?:\/\/[^/]+$/u.test(target)) {
          throw new SyntaxError(`Invalid target origin '${target}'`);
        }
        posted.push(target);
      },
    };
    const child = { postMessage: (message: unknown) => delivered.push(message), focus: () => {} };
    const element = () => ({
      setAttribute: () => {},
      style: {},
      contentWindow: child,
      addEventListener: () => {},
      focus: () => {},
    });
    const self: Record<string, unknown> = {};
    Object.assign(self, {
      parent: parentWindow,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === "message") {
          listeners.push(listener);
        }
      },
    });
    runInNewContext(script, {
      window: self,
      location: {
        origin,
        hostname: new URL(origin).hostname,
        ...(parent === undefined ? {} : { ancestorOrigins: [parent] }),
      },
      document: {
        documentElement: { style: {} },
        body: { style: {}, append: () => {} },
        createElement: element,
        hasFocus: () => false,
        addEventListener: () => {},
      },
      navigator: {},
      performance: { now: () => 0 },
      requestAnimationFrame: () => 0,
      setTimeout: () => 0,
      setInterval: () => 0,
      clearTimeout: () => {},
      addEventListener: self.addEventListener,
      fetch: () => new Promise(() => {}),
      URL,
    });
    // The page says something (its child window is the source), then the parent says something.
    for (const listener of listeners) {
      listener({
        source: child,
        origin: "null",
        data: { jsonrpc: "2.0", method: "ui/ping", id: 1 },
      });
      listener({
        source: parentWindow,
        origin: from,
        data: { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: {} },
      });
    }
    return { posted, delivered };
  }

  it("a nested page's shell: the outer page as its parent hears no * and its words never reach the page", () => {
    const strict = shellSaid([DECK], DECK, DECK);
    expect(strict.posted).not.toContain("*");
    expect(strict.posted.length).toBeGreaterThan(0);
    expect(strict.delivered, "the outer page's word reached the page").toEqual([]);
    // The host's own word goes on, and a desktop parent named so still hears *.
    const desktop = shellSaid([DECK], DESKTOP, HOST);
    expect(desktop.posted).toContain("*");
    expect(desktop.delivered).toHaveLength(1);
    // The control: without framedBy the shell says * to a parent it can't place (the old rule).
    expect(shellSaid([], DECK, HOST).posted).toContain("*");
  });

  it("a content Worker's door and status pages tell the hosts alone", async () => {
    const said = (
      await doorResponse({ hostOrigins: [HOST, DESKTOP], framedBy: [DECK] }).text()
    ).match(/data-porthole-[a-z-]+/gu);
    expect(said).toContain("data-porthole-strict-parent");
    expect(FRAME_STATUS_METHOD).toBe("porthole/notifications/frame-status");
  });
});

describe("the host kit passes framedBy on (P141)", () => {
  const kit = (framedBy?: readonly string[]) =>
    createContentHost<{ id: string }>({
      domain: DOMAIN,
      appOrigins: [HOST],
      ...(framedBy === undefined ? {} : { framedBy }),
      secret,
      configs: { artifact: configs.artifact },
      instance: () => null,
      access: () => null,
      entry: {
        at: () => null,
        handoff: { id: (viewer: { id: string }) => viewer.id, viewer: () => null },
      },
      name: { label: (scope: string) => `a-${scope}`, scopeOf: (label: string) => label.slice(2) },
    } as unknown as Parameters<typeof createContentHost<{ id: string }>>[0]);

  it("its content and its authorize route's pages may be framed below the outer page; the handoff stays the app's", async () => {
    const host = kit([DECK]);
    const page = await host.authorize(() => null)(
      new Request(`${HOST}/porthole/authorize?state=nope`, {
        headers: { "sec-fetch-dest": "iframe" },
      }),
    );
    expect(ancestorsOf(page)).toEqual([HOST, DECK]);
    expect(await page.text()).not.toContain("deck.example.net");
    const handoff = await host.handoff(() => ({ id: "ada" }))(
      new Request(`${HOST}/porthole/handoff`, { method: "POST", headers: { origin: DECK } }),
    );
    expect(handoff.status, "the outer page hands no viewer over").toBe(403);
    const own = await host.handoff(() => ({ id: "ada" }))(
      new Request(`${HOST}/porthole/handoff`, { method: "POST", headers: { origin: HOST } }),
    );
    expect(own.status, "the app's own page still does").toBe(204);
    const content = await host.fetch(ask(`https://a-x.${DOMAIN}/nothing`));
    expect(ancestorsOf(content!)).toEqual([HOST, DECK]);
  });

  it("refuses a bad one as it refuses a bad app origin", () => {
    expect(() => kit(["https://*.deck.example"])).toThrow(/framedBy/u);
    expect(() => kit([HOST])).toThrow(/host origin already/u);
    expect(() => kit([`${HOST}:443`])).toThrow(/host origin already/u);
  });
});

/**
 * 0.14.16's scripts, by their sha256 as a policy names them: the status, entry and door pages'
 * (`git show v0.14.16:packages/porthole/src/server/pages.ts`). 0.14.17 changed them and the nested
 * page's shell on every path, with a branch only `framedBy` takes (P144, after Ferryman's audit of
 * 0.14.18): without `framedBy` (and without embed, P143), every response that carries one of the
 * pages' scripts carries 0.14.16's again, byte for byte (the nested page's shell was 0.14.16's too
 * until 0.15.3, below: P148; the shell runtime served documents inline is another matter: P145).
 */
const V0_14_16 = {
  status: "'sha256-XB1Co2NQ5DJ8+kmWSugeVUXsldJaHiI7gXXoH+yitRw='",
  enter: "'sha256-Lzrcu1/YmcGN5E7MYSqe2IBdqoDfIZXsCiQn3fJclJY='",
  door: "'sha256-v9Jwr3GLqqhJUL7YFH0fgjsdZgRs8zIYdIvmchvGd3A='",
};
/**
 * The nested page's shell: 0.16.0's. Not 0.14.16's since 0.15.3: P148 changed it on every path
 * (a port for its page at each load, the presses it hears in its state), and P149 (0.16.0) again
 * (the store it frames where the plan names one, and the channel it hands out: inert without a
 * store). Its `script-src` hash changes for every host each time, which the CHANGELOG says.
 * 0.14.16's were 'sha256-0nIZ304ltfsUzuaJh0kqjvbMpA4cPJT1suOXSIRIPMA=' (its runtime) and
 * 'sha256-pzr8GzzEGqwx1Kqp7zaknNd3kSfdsrZXQrdtRrDrBm8=' (its script for `PINNED_SHELL`); 0.15.3's
 * 'sha256-QyOMnn/OtyVsbtPdzm3O4Ukmt4TexmpMMPZqt/dS+jY=' and
 * 'sha256-chcrn5hFVbPIkXKYTaZDKpCJnn+VkxJXickgRiImAGc='. Pinned as the pages' are, so the next
 * change to it is said too. The default path's still carries nothing of `framedBy`'s (P144).
 */
const SHELL_V0_16_0 = {
  shellRuntime: "'sha256-7LpAlWbdvPXvwBhMdauWU8+ijjcaARRIux6IX/3iw/w='",
  shell: "'sha256-D2Btp9c6nhW3S1+JEfeDU3hAEu3GWKGYEynBZLsygBQ='",
};
const PINNED_HOSTS = ["https://host.example", "ferry://app"];
const PINNED_ORIGIN = "https://porthole-abcdefghijklmnopqrstuvwx.content.example";
const PINNED_SHELL = {
  origins: PINNED_HOSTS,
  page: `${PINNED_ORIGIN}/__porthole/f/x/`,
  title: "T",
};

const hashOf = (script: string): string =>
  `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
const scriptSrcOf = (response: Response): string =>
  /script-src ([^;]+)/u.exec(response.headers.get("content-security-policy") ?? "")?.[1] ?? "";
const inlineScriptOf = (html: string): string =>
  /<script>([\s\S]*)<\/script>/u.exec(html)?.[1] ?? "";

describe("without framedBy, the pages' scripts are 0.14.16's, byte for byte, and the nested shell's is 0.16.0's (P144, P148, P149)", () => {
  it("the status and entry pages' scripts", async () => {
    expect(hashOf((await pageScript(STATUS_SCRIPT_PATH)?.text()) ?? "")).toBe(V0_14_16.status);
    expect(hashOf((await pageScript(ENTER_SCRIPT_PATH)?.text()) ?? "")).toBe(V0_14_16.enter);
  });

  it("the door's, and the status script inline (a door that doesn't open, a relay's status page)", async () => {
    const door = doorResponse({ hostOrigins: PINNED_HOSTS });
    expect(scriptSrcOf(door)).toBe(V0_14_16.door);
    expect(hashOf(inlineScriptOf(await door.text()))).toBe(V0_14_16.door);
    for (const response of [
      doorStatusResponse({ hostOrigins: PINNED_HOSTS, status: 401, reason: "session" }),
      statusPage({ status: 404, title: "t", detail: "d", hostOrigins: PINNED_HOSTS }),
    ]) {
      expect(scriptSrcOf(response)).toBe(V0_14_16.status);
      expect(hashOf(inlineScriptOf(await response.text()))).toBe(V0_14_16.status);
    }
  });

  it("the nested page's shell: 0.16.0's (P148, P149)", async () => {
    expect(hashOf(FRAME_SHELL_RUNTIME)).toBe(SHELL_V0_16_0.shellRuntime);
    expect(hashOf(frameShellScript(PINNED_SHELL))).toBe(SHELL_V0_16_0.shell);
    const shell = nestedShellResponse(compile(configs.artifactNested), {
      ...PINNED_SHELL,
      origin: PINNED_ORIGIN,
    });
    expect(scriptSrcOf(shell)).toBe(SHELL_V0_16_0.shell);
    expect(await shell.text()).not.toContain("strictParent");
  });

  it("a server without framedBy answers with them: its pages load 0.14.16's scripts, its door and nested shell carry them", async () => {
    const porthole = server({ framedBy: [] });
    const answers = await everyAnswer(porthole);
    const named = (name: string) => answers.find((each) => each.name === name)?.response;
    for (const name of ["shell's ticket used", "not found"]) {
      expect(await named(name)?.text(), name).toContain(`<script src="${STATUS_SCRIPT_PATH}">`);
    }
    expect(await named("url mode: the entry page")?.text()).toContain(
      `<script src="${ENTER_SCRIPT_PATH}">`,
    );
    const { origin } = await porthole.issue(
      { scope: "s9", document: { kind: "shell", preset: "inlineWidget" } },
      { viewer: "v" },
    );
    for (const [path, hash] of [
      [STATUS_SCRIPT_PATH, V0_14_16.status],
      [ENTER_SCRIPT_PATH, V0_14_16.enter],
    ] as const) {
      const served = await porthole.handle(ask(`${origin}${path}`, "script"));
      expect(hashOf((await served?.text()) ?? ""), path).toBe(hash);
    }
    for (const name of ["door", "door used"]) {
      const response = named(name);
      expect(response, name).toBeDefined();
      expect([V0_14_16.door, V0_14_16.status], name).toContain(scriptSrcOf(response!));
    }
    // The nested shell: the default runtime (0.16.0's), its own plan spliced in.
    const nested = named("nested shell")!;
    const script = inlineScriptOf(await nested.clone().text());
    expect(scriptSrcOf(nested)).toBe(hashOf(script));
    const [before = "", after = ""] = FRAME_SHELL_RUNTIME.split("__PLAN__");
    expect(script.startsWith(before) && script.endsWith(after)).toBe(true);
  });

  it("with framedBy, the strict pages load scripts of their own, and the default paths still serve 0.14.16's", async () => {
    const porthole = server();
    const answers = await everyAnswer(porthole);
    const named = (name: string) => answers.find((each) => each.name === name)?.response;
    expect(await named("not found")?.text()).toContain(
      `<script src="${STRICT_STATUS_SCRIPT_PATH}">`,
    );
    expect(await named("url mode: the entry page")?.text()).toContain(
      `<script src="${STRICT_ENTER_SCRIPT_PATH}">`,
    );
    const { origin } = await porthole.issue(
      { scope: "s9", document: { kind: "shell", preset: "inlineWidget" } },
      { viewer: "v" },
    );
    for (const path of [STRICT_STATUS_SCRIPT_PATH, STRICT_ENTER_SCRIPT_PATH]) {
      const served = await porthole.handle(ask(`${origin}${path}`, "script"));
      expect(await served?.text(), path).toContain("portholeStrictParent");
    }
    const served = await porthole.handle(ask(`${origin}${STATUS_SCRIPT_PATH}`, "script"));
    expect(hashOf((await served?.text()) ?? "")).toBe(V0_14_16.status);
    const door = doorResponse({ hostOrigins: PINNED_HOSTS, framedBy: [DECK] });
    expect(scriptSrcOf(door)).not.toBe(V0_14_16.door);
    expect(hashOf(inlineScriptOf(await door.text()))).toBe(scriptSrcOf(door));
    expect(STRICT_FRAME_SHELL_RUNTIME).not.toBe(FRAME_SHELL_RUNTIME);
    expect(frameShellScript({ ...PINNED_SHELL, framedBy: [DECK] })).toContain(
      '"strictParent":true',
    );
  });
});

/**
 * The shell runtime every served document inlines (a served shell, an artifact page, a file set's
 * pages, the MCP Apps proxy, a nested page): not 0.14.16's. It carries P142's changes (0.14.18) and
 * P143's `hostless` branches (0.15.0), inert wherever the plan names a host. 0.15.0 said "the
 * default path is 0.14.16's again, byte for byte", which held for the four scripts above and every
 * header, not for this (Ferryman's audit of 0.15.0, P145). No hash covers it (`script-src` is
 * `'unsafe-inline'` for these documents), so it is pinned here: a change to its bytes fails this
 * test, and is said in the CHANGELOG, not assumed away (0.15.2: annotations', P147; 0.15.3: the
 * shell's, P148; 0.16.0: the shell's, P149). From `git show v0.15.0:…/src/shell/*.ts`
 * and `git show v0.14.16:…` (`SHELL_RUNTIME`, `ANNOTATE_RUNTIME`, `FIND_RUNTIME`, `USE_RUNTIME`,
 * `LEGACY_GLOBALS_RUNTIME`).
 */
const RUNTIME_V0_16_0 = {
  // 0.15.0's was 'sha256-kafLnuVV2E6YUJtxXEooMNi8MNwbMJRdYi+0PTOe1RA='. 0.15.3's tells a nested
  // page's shell its real presses (P148: 'sha256-kWx9H3mLZTPs2MHT4fmpNuaZN9qIXLAVePeULjBsq/U=');
  // 0.16.0's keeps a nested page's storage where its config does (P149). Each is installed only
  // under a nested page's plan.
  shell: "'sha256-oaHI5QMTPlPqvjNZ/U1acbXOchDS0Rk7BfIzQu4lI48='",
  // 0.15.0's was 'sha256-3PZMe4arifdWHJU1jS0laR49wiWc/uBWIFddGJPyf/w=': 0.15.2's marks ride the
  // document's scroll (P147). The other three are 0.15.0's.
  annotate: "'sha256-uQ77dZDXcY6pKRoTylHpGXY+ZhhCt4WZhB/qDTQJ6BE='",
  find: "'sha256-invvWJWqsN6Zv0kMLG2eeofMX6XmKNSqsvYydiElDGc='",
  use: "'sha256-TJx7YF/WvrHHkz8iTPfUfH6GNUEgES6O+0+igLRmyPQ='",
  legacy: "'sha256-ZEVJsezqV7n+Ho0m7Y92NYxAZqf8ynKq/rDdXrJUKp0='",
};
const RUNTIME_V0_14_16 = {
  shell: "'sha256-8svnEfnvxleYrCo6NIinDLSpcd5tu6++3CxlDUvma3Q='",
  annotate: "'sha256-jf7Z8UE3pAtdnMpM7kIfdpnLSs1sPrK8/4fE+jxbUqs='",
  find: "'sha256-Fim3NMYzFyomgFsW6tuOFuydk0Hwcy1az2ICGXj3fn4='",
  use: "'sha256-TJx7YF/WvrHHkz8iTPfUfH6GNUEgES6O+0+igLRmyPQ='",
  legacy: "'sha256-ZEVJsezqV7n+Ho0m7Y92NYxAZqf8ynKq/rDdXrJUKp0='",
};

describe("the served shell runtime is 0.16.0's (0.15.0's, but for annotations, P147, a nested page's presses, P148, and its kept storage, P149), not 0.14.16's: pinned, so what the CHANGELOG says of it is checked (P145)", () => {
  const now = {
    shell: hashOf(SHELL_RUNTIME),
    annotate: hashOf(ANNOTATE_RUNTIME),
    find: hashOf(FIND_RUNTIME),
    use: hashOf(USE_RUNTIME),
    legacy: hashOf(LEGACY_GLOBALS_RUNTIME),
  };

  it("its bytes are 0.16.0's (a change here is a change every served document carries: say it)", () => {
    expect(now).toEqual(RUNTIME_V0_16_0);
  });

  it("which are not 0.14.16's: the shell's, annotations' and find's differ (P142, P143)", () => {
    expect(now.shell).not.toBe(RUNTIME_V0_14_16.shell);
    expect(now.annotate).not.toBe(RUNTIME_V0_14_16.annotate);
    expect(now.find).not.toBe(RUNTIME_V0_14_16.find);
    expect({ use: now.use, legacy: now.legacy }).toEqual({
      use: RUNTIME_V0_14_16.use,
      legacy: RUNTIME_V0_14_16.legacy,
    });
  });

  it("on the default path its P143 branches are there and inert: the plan names its hosts", async () => {
    const porthole = server({ framedBy: [] });
    const page = await porthole.issue(
      { scope: "s-rt", document: { kind: "artifact", id: "page", version: "1" } },
      { viewer: "v" },
    );
    const html = (await (await porthole.handle(ask(page.url)))?.text()) ?? "";
    expect(html).toContain(
      "const hostless = Array.isArray(plan.origins) && plan.origins.length === 0;",
    );
    expect(html).toContain(`"origins":${JSON.stringify([HOST, DESKTOP])}`);
  });
});

describe("framedBy is compared with the host origins as browsers serialize origins (P144)", () => {
  const base = {
    content: { domain: DOMAIN, scheme: "https" as const },
    secret,
    configs: {},
  };

  it("normalOrigin lowercases and drops a default port", () => {
    expect(normalOrigin("https://app.example.com:443")).toBe("https://app.example.com");
    expect(normalOrigin("HTTPS://App.Example.COM")).toBe("https://app.example.com");
    expect(normalOrigin("http://localhost:80")).toBe("http://localhost");
    expect(normalOrigin("http://[::1]:80")).toBe("http://[::1]");
    expect(normalOrigin("https://app.example.com:8443")).toBe("https://app.example.com:8443");
    expect(normalOrigin("http://localhost:443")).toBe("http://localhost:443");
    expect(normalOrigin("Ferry://App")).toBe("ferry://app");
    expect(includesOrigin([HOST], `${HOST}:443`)).toBe(true);
    expect(includesOrigin([`${HOST}:443`], HOST)).toBe(true);
    expect(includesOrigin([HOST], `${HOST}:8443`)).toBe(false);
  });

  it("a host origin with or without its default port is a host origin already", () => {
    expect(() => createServer({ ...base, hostOrigins: [HOST], framedBy: [`${HOST}:443`] })).toThrow(
      /host origin already/u,
    );
    expect(() => createServer({ ...base, hostOrigins: [`${HOST}:443`], framedBy: [HOST] })).toThrow(
      /host origin already/u,
    );
    expect(() =>
      createServer({ ...base, hostOrigins: [HOST], framedBy: [`${HOST}:8443`] }),
    ).not.toThrow();
    expect(() =>
      createServer({
        ...base,
        hostOrigins: ["http://localhost:5173"],
        framedBy: ["http://localhost"],
      }),
    ).not.toThrow();
    expect(() =>
      createServer({
        ...base,
        hostOrigins: ["http://localhost"],
        framedBy: ["http://localhost:80"],
      }),
    ).toThrow(/host origin already/u);
  });

  it("the helpers a content Worker of its own answers with compare them so too", () => {
    expect(() => doorResponse({ hostOrigins: [HOST], framedBy: [`${HOST}:443`] })).toThrow(
      /host origin/u,
    );
    expect(() =>
      statusPage({
        status: 401,
        title: "t",
        detail: "d",
        hostOrigins: [`${HOST}:443`],
        framedBy: [HOST],
      }),
    ).toThrow(/host origin/u);
    expect(() =>
      nestedShellCsp("1;", "https://porthole-x.example", [HOST], [`${HOST}:443`]),
    ).toThrow(/host origin/u);
    const origin = `https://${nestedLabelOf("abc")}.${DOMAIN}`;
    expect(() =>
      frameShellScript({
        origins: [HOST],
        framedBy: [`${HOST}:443`],
        page: `${origin}/__porthole/f/x/`,
      }),
    ).toThrow(/host origin/u);
  });

  it("an outer page named twice, with and without its default port, is named once", () => {
    expect(
      ancestorsOf(doorResponse({ hostOrigins: [HOST], framedBy: [DECK, `${DECK}:443`] })),
    ).toEqual([HOST, DECK]);
    expect(
      ancestorsOf(
        statusPage({
          status: 404,
          title: "t",
          detail: "d",
          hostOrigins: [HOST],
          framedBy: [DECK, `${DECK}:443`],
        }),
      ),
    ).toEqual([HOST, DECK]);
  });
});
