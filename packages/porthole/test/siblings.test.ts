import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { presets } from "../src/index.ts";
import type { InstanceRef } from "../src/isolation/types.ts";
import { nodeHost } from "../src/node/index.ts";
import {
  createContentHost,
  createServer,
  prefixedName,
  type AuthorizeRequest,
  type ServerOptions,
} from "../src/server/index.ts";

/**
 * The 2026-10-19 audit, round 2, P0.3 (scenarios S3 and S6; P101). Every label of the content
 * domain is same-site with every other (P047, until the domain is on the Public Suffix List), and
 * a url-mode app is arbitrary code on one of them: it may set a `Domain=` cookie every label gets
 * (cookie tossing), and request any sibling with that sibling's cookies. So under https only
 * `__Host-` names are Porthole's (a sibling can set any other name for the whole domain, never a
 * `__Host-` one); the entered mark is its label's; and a url-mode app answers what its own origin
 * asks, or a navigation that opens it, nothing else another origin sends.
 */

const secret = new Uint8Array(32).fill(9);
const HOST = "https://app.example.com";
const DOMAIN = "example-usercontent.com";
const CONTENT = `https://*.${DOMAIN}`;
const AUTHORIZE = `${HOST}/porthole/authorize`;

const app = (scope: string): InstanceRef => ({
  scope,
  document: { kind: "external", url: "http://localhost:5173/" },
});
const artifact = (scope: string): InstanceRef => ({
  scope,
  document: { kind: "artifact", id: "page", version: "1" },
});

/** A server with a url-mode upstream that records what reaches it, and the host's check. */
function server(extra: Partial<ServerOptions> = {}) {
  const upstream: Request[] = [];
  const checked: AuthorizeRequest[] = [];
  const porthole = createServer({
    content: { domain: DOMAIN, scheme: "https" },
    secret,
    hostOrigins: [HOST],
    configs: {
      artifact: presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] }),
    },
    artifacts: { get: async (id, version) => ({ html: `<h1 id="t">${id} v${version}</h1>` }) },
    upstream: (request) => {
      upstream.push(request);
      return new Response("app", {
        headers: [
          ["set-cookie", "theirs=2; Path=/"],
          ["set-cookie", "porthole-z=1; Path=/"],
          ["set-cookie", "__Secure-porthole-z=1; Path=/; Secure"],
          ["set-cookie", "__Host-porthole-z=1; Path=/; Secure"],
        ],
      });
    },
    authorize: {
      check: (asked) => {
        checked.push(asked);
        return { allow: true };
      },
    },
    ...extra,
  });
  return { porthole, upstream, checked };
}

const request = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(url, { method, headers: { "sec-fetch-dest": "iframe", ...headers } });

/** The `name=value` pairs a response sets. */
const pairsOf = (response: Response): string[] =>
  response.headers.getSetCookie().map((each) => each.split(";")[0] ?? "");

/** A url-mode app entered in a frame: its origin and its session cookie's name and value. */
async function enter(porthole: ReturnType<typeof createServer>, scope: string) {
  const location = await porthole.issue(app(scope), { viewer: "dev" });
  const entered = (await porthole.handle(request(location.url))) as Response;
  const [pair = ""] = pairsOf(entered);
  const at = pair.indexOf("=");
  return { origin: location.origin, name: pair.slice(0, at), value: pair.slice(at + 1) };
}

describe("P0.3 / S3: under https only __Host- names are Porthole's (P101)", () => {
  it("a url-mode session under any other name opens nothing: no request, no socket", async () => {
    const { porthole, upstream } = server();
    const { origin, name, value } = await enter(porthole, "preview-1");
    expect(name).toMatch(/^__Host-porthole-[a-z2-7]{16}$/u);
    const key = name.slice("__Host-porthole-".length);
    // The real one opens the app and its socket.
    expect(
      (await porthole.handle(request(`${origin}/x`, { cookie: `${name}=${value}` })))?.status,
    ).toBe(200);
    expect(
      await porthole.access(request(`${origin}/ws`, { cookie: `${name}=${value}` })),
    ).not.toBeNull();
    // What a sibling label can plant for the whole content domain (`Domain=`), and a name that
    // reads as `__Host-` only once a parser trims more than spaces and tabs (U+00A0, latin1).
    for (const planted of [
      `porthole-${key}`,
      `__Secure-porthole-${key}`,
      `__host-porthole-${key}`,
      ` __Host-porthole-${key}`,
    ]) {
      const cookie = `${planted}=${value}`;
      const answer = (await porthole.handle(request(`${origin}/x`, { cookie }))) as Response;
      expect(answer.status, planted).toBe(401);
      expect(await porthole.access(request(`${origin}/ws`, { cookie })), planted).toBeNull();
      expect(
        (await porthole.handle(request(`${origin}/__porthole/session`, { cookie })))?.status,
        planted,
      ).toBe(401);
    }
    expect(upstream).toHaveLength(1);
  });

  it("the upstream gets none of Porthole's names, and sets none, whatever their prefix", async () => {
    const { porthole, upstream } = server();
    const { origin, name, value } = await enter(porthole, "preview-2");
    const answer = (await porthole.handle(
      request(`${origin}/x`, {
        cookie: `porthole-x=1; ${name}=${value}; __Secure-porthole-y=2; theirs=1; __Host-porthole-w=3`,
      }),
    )) as Response;
    expect(answer.status).toBe(200);
    expect(upstream[0]?.headers.get("cookie")).toBe("theirs=1");
    expect(pairsOf(answer)).toEqual(["theirs=2"]);
  });

  it("over plain http (loopback dev) the names are unprefixed, set and read; __Host- ones aren't", async () => {
    const dev = createServer({
      content: { domain: "localhost", scheme: "http", port: 8790 },
      secret,
      hostOrigins: ["http://127.0.0.1:8790"],
      configs: {},
      upstream: () => new Response("app"),
    });
    const { origin, name, value } = await enter(dev, "preview-3");
    expect(name).toMatch(/^porthole-[a-z2-7]{16}$/u);
    expect((await dev.handle(request(`${origin}/x`, { cookie: `${name}=${value}` })))?.status).toBe(
      200,
    );
    expect(
      (await dev.handle(request(`${origin}/x`, { cookie: `__Host-${name}=${value}` })))?.status,
    ).toBe(401);
  });
});

/** An entry begun on `scope`'s clean address and authorized as someone: its nonce's name, its code. */
async function someonesCode(porthole: ReturnType<typeof createServer>, scope: string) {
  const begin = (await porthole.handle(
    request(porthole.urlOf(scope, "/"), { "sec-fetch-dest": "document" }),
  )) as Response;
  const [nonce = ""] = pairsOf(begin);
  const state = porthole.entryState(
    new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "",
  );
  const code = await porthole.enterBy(state!, artifact(scope), { viewer: "someone" });
  return { name: nonce.slice(0, nonce.indexOf("=")), code };
}

describe("P0.3 / S3: a cookie one label sets for the whole domain is never another label's session or grant (P101)", () => {
  const schemes = {
    https: () => server({ entry: { authorizeUrl: AUTHORIZE } }).porthole,
    "http (loopback)": () =>
      createServer({
        content: { domain: "localhost", scheme: "http", port: 8790 },
        secret,
        hostOrigins: ["http://127.0.0.1:8790"],
        configs: {
          artifact: presets.artifact({
            isolation: "domain",
            contentOrigins: ["http://*.localhost:8790"],
          }),
        },
        artifacts: { get: async () => ({ html: "<h1>page</h1>" }) },
        upstream: () => new Response("app"),
        entry: { authorizeUrl: "http://127.0.0.1:8790/porthole/authorize" },
      }),
  };
  for (const [scheme, make] of Object.entries(schemes)) {
    it(`${scheme}: label B's session, under any name, opens nothing on label A`, async () => {
      const porthole = make();
      const a = await enter(porthole, "fix-a");
      const b = await enter(porthole, "fix-b");
      const bare = (name: string) => name.replace(/^__Host-/u, "");
      // What B's holder can plant with `Domain=`: its own session, under B's name or A's, with
      // the prefix or without (a sibling can't set a __Host- one; a header can still carry it).
      for (const cookie of [
        `${b.name}=${b.value}`,
        `${bare(b.name)}=${b.value}`,
        `${a.name}=${b.value}`,
        `${bare(a.name)}=${b.value}`,
        `__Host-${bare(a.name)}=${b.value}`,
      ]) {
        const answer = (await porthole.handle(
          request(`${a.origin}/x`, { cookie, "sec-fetch-dest": "document" }),
        )) as Response;
        expect(answer.status, cookie).not.toBe(200);
        expect(await porthole.access(request(`${a.origin}/ws`, { cookie })), cookie).toBeNull();
      }
    });

    it(`${scheme}: an entry code redeems only with its nonce cookie under Porthole's own name`, async () => {
      // Someone begins an entry on label A in their own browser, and is given its code; a sibling
      // plants its nonce for the whole domain, under the name a sibling can set over https.
      const porthole = make();
      const { name, code } = await someonesCode(porthole, "fix-c");
      const planted = name.startsWith("__Host-")
        ? `${name.slice("__Host-".length)}=1`
        : `__Host-${name}=1`;
      const answer = (await porthole.handle(
        request(code, { cookie: planted, "sec-fetch-dest": "document" }),
      )) as Response;
      expect(answer.status).toBe(401);
      expect(pairsOf(answer)).toEqual([]);
    });
  }

  it("http (loopback), the residual: a planted copy under Porthole's own name is read there", async () => {
    // Measured (P101): WebKit keeps no __Host- (Secure) cookie on a tab of http://*.localhost, so
    // loopback's names are unprefixed, and a sibling can set the very name. A copy of a session or
    // a nonce of this label's own is read: only someone holding one (they are HttpOnly, never in a
    // frame, a ticket taken once) can plant it, on a developer's own loopback server. Pinned, so a
    // change of loopback's names shows here.
    const porthole = schemes["http (loopback)"]();
    const a = await enter(porthole, "fix-d");
    const copy = `${a.name}=${a.value}`;
    expect((await porthole.handle(request(`${a.origin}/x`, { cookie: copy })))?.status).toBe(200);
    const { name, code } = await someonesCode(porthole, "fix-e");
    const answer = (await porthole.handle(
      request(code, { cookie: `${name}=1`, "sec-fetch-dest": "document" }),
    )) as Response;
    expect(answer.status).toBe(303);
  });
});

/** A browser's cookie jar per host, as `test/entry.test.ts` keeps one. */
class Jar {
  readonly hosts = new Map<string, Map<string, string>>();
  header(url: string): string {
    return [...(this.hosts.get(new URL(url).host) ?? [])]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
  keep(url: string, response: Response): void {
    const host = new URL(url).host;
    const cookies = this.hosts.get(host) ?? new Map<string, string>();
    for (const pair of pairsOf(response)) {
      const at = pair.indexOf("=");
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    this.hosts.set(host, cookies);
  }
}

/**
 * A clean address entered (P068) on `scope`'s origin at `/`: the jar then holds its session and
 * its entered mark (the nonce cookie, after the code was redeemed).
 */
async function cleanEntry(porthole: ReturnType<typeof createServer>, scope: string, jar: Jar) {
  const url = porthole.urlOf(scope, "/");
  const send = async (at: string) => {
    const cookie = jar.header(at);
    const answer = (await porthole.handle(
      request(
        at,
        cookie === "" ? { "sec-fetch-dest": "document" } : { cookie, "sec-fetch-dest": "document" },
      ),
    )) as Response;
    jar.keep(at, answer);
    return answer;
  };
  const begin = await send(url);
  expect(begin.status).toBe(302);
  const state = porthole.entryState(
    new URL(begin.headers.get("location") ?? "").searchParams.get("state") ?? "",
  );
  expect(state).not.toBeNull();
  const code = await porthole.enterBy(state!, artifact(scope), { viewer: "ada" });
  const redeemed = await send(code);
  expect(redeemed.status).toBe(303);
  return { url, send };
}

describe("P0.3 / S3: the entered mark and clean-address sessions are their label's (P101)", () => {
  it("a mark redeemed on one label stands for nothing on another", async () => {
    const { porthole } = server({ entry: { authorizeUrl: AUTHORIZE } });
    const jar = new Jar();
    const { url } = await cleanEntry(porthole, "page-a", jar);
    const marks = [...(jar.hosts.get(new URL(url).host) ?? [])].filter(([name]) =>
      name.startsWith("__Host-porthole-n-"),
    );
    expect(marks).toHaveLength(1);
    const [[, mark] = ["", ""]] = marks;
    expect(mark).toMatch(/^e\./u);
    // On another label, at the same path: the browser holds that mark under a nonce cookie's name
    // (planted by a sibling under a name only a cookie-prefix bypass gets past the engine), and
    // its own entry still begins, rather than "open this in a new tab".
    const other = porthole.urlOf("page-b", "/");
    const answer = (await porthole.handle(
      request(other, {
        cookie: `__Host-porthole-n-aaaaaaaaaaaaaaaa=${mark}`,
        "sec-fetch-dest": "document",
      }),
    )) as Response;
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toMatch(
      /^https:\/\/app\.example\.com\/porthole\/authorize\?state=/u,
    );
  });

  it("a clean address's session under an unprefixed name opens nothing", async () => {
    const { porthole } = server({ entry: { authorizeUrl: AUTHORIZE } });
    const jar = new Jar();
    const { url, send } = await cleanEntry(porthole, "page-c", jar);
    const opened = await send(url);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain("page v1");
    const session = [...(jar.hosts.get(new URL(url).host) ?? [])].find(
      ([name]) => !name.startsWith("__Host-porthole-n-"),
    );
    expect(session?.[0]).toMatch(/^__Host-porthole-/u);
    const planted = `${session?.[0].slice("__Host-".length)}=${session?.[1]}`;
    const answer = (await porthole.handle(
      request(url, { cookie: planted, "sec-fetch-dest": "document" }),
    )) as Response;
    expect(answer.status).toBe(302);
  });
});

/** Fetch metadata and `Origin` as engines send them, by who asks. */
const SIBLING = `https://bbbbbbbbbbbbbbbbbbbbbbbb.${DOMAIN}`;
const meta = (
  site: string,
  mode: string,
  dest: string,
  origin?: string,
): Record<string, string> => ({
  "sec-fetch-site": site,
  "sec-fetch-mode": mode,
  "sec-fetch-dest": dest,
  ...(origin === undefined ? {} : { origin }),
});

describe("P0.3 / S6: a url-mode app answers its own origin, and navigations that open it (P101)", () => {
  /** Each request: its method, its headers (`OWN` for the app's own origin), whether it goes on. */
  const OWN = "<own>";
  const http: [string, string, Record<string, string>, boolean][] = [
    ["the app's own fetch POST", "POST", meta("same-origin", "cors", "empty", OWN), true],
    ["the app's own script", "GET", meta("same-origin", "no-cors", "script"), true],
    ["the app's own form POST", "POST", meta("same-origin", "navigate", "iframe", OWN), true],
    ["the host framing it", "GET", meta("cross-site", "navigate", "iframe"), true],
    ["a sibling's link, on a tab", "GET", meta("same-site", "navigate", "document"), true],
    ["a typed address", "GET", meta("none", "navigate", "document"), true],
    ["a HEAD navigation from another site", "HEAD", meta("cross-site", "navigate", "iframe"), true],
    ["a client sending no fetch metadata", "POST", {}, true],
    ["a sibling's fetch POST", "POST", meta("same-site", "cors", "empty", SIBLING), false],
    ["a sibling's no-cors POST", "POST", meta("same-site", "no-cors", "empty", SIBLING), false],
    ["another site's script tag", "GET", meta("cross-site", "no-cors", "script"), false],
    ["a sibling's image", "GET", meta("same-site", "no-cors", "image"), false],
    ["a sibling's form POST", "POST", meta("same-site", "navigate", "iframe", SIBLING), false],
    [
      "another site's form POST, on a tab",
      "POST",
      meta("cross-site", "navigate", "document", "https://evil.example"),
      false,
    ],
    ["an opaque origin's fetch", "POST", meta("cross-site", "cors", "empty", "null"), false],
    ["a foreign Origin, no fetch metadata", "POST", { origin: "https://evil.example" }, false],
    [
      "a sibling's WebSocket, through the fetch handler (Workers)",
      "GET",
      { ...meta("same-site", "websocket", "websocket", SIBLING), upgrade: "websocket" },
      false,
    ],
  ];

  it("over HTTP: the refused get a 403, reaching neither the upstream nor the host's check", async () => {
    const { porthole, upstream, checked } = server();
    const { origin, name, value } = await enter(porthole, "preview-6");
    const before = checked.length;
    for (const [who, method, headers, goes] of http) {
      upstream.length = 0;
      checked.length = before;
      const given = Object.fromEntries(
        Object.entries(headers).map(([key, each]) => [key, each === OWN ? origin : each]),
      );
      const answer = (await porthole.handle(
        new Request(`${origin}/api`, {
          method,
          headers: { cookie: `${name}=${value}`, ...given },
        }),
      )) as Response;
      if (goes) {
        expect(answer.status, who).toBe(200);
        expect(upstream, who).toHaveLength(1);
      } else {
        expect(answer.status, who).toBe(403);
        expect(upstream, who).toHaveLength(0);
        expect(checked.length, who).toBe(before);
        expect(await answer.text(), who).toContain("data-porthole-reason=");
      }
    }
  });

  it("a socket (`access`, the host's upgrade path): only the app's own origin, never a navigation's", async () => {
    const { porthole } = server();
    const { origin, name, value } = await enter(porthole, "preview-7");
    const ws = { upgrade: "websocket", connection: "Upgrade" };
    const cases: [string, Record<string, string>, boolean][] = [
      ["the app's own", { ...ws, ...meta("same-origin", "websocket", "websocket", origin) }, true],
      ["Origin alone (an engine without fetch metadata)", { ...ws, origin }, true],
      ["a client that sends neither", ws, true],
      ["a sibling's", { ...ws, ...meta("same-site", "websocket", "websocket", SIBLING) }, false],
      [
        "another site's",
        { ...ws, ...meta("cross-site", "websocket", "websocket", "https://evil.example") },
        false,
      ],
      [
        "an opaque origin's",
        { ...ws, ...meta("cross-site", "websocket", "websocket", "null") },
        false,
      ],
      ["a foreign Origin, no fetch metadata", { ...ws, origin: SIBLING }, false],
      [
        "no Origin, but another site's metadata",
        { ...ws, ...meta("cross-site", "navigate", "document") },
        false,
      ],
    ];
    for (const [who, headers, goes] of cases) {
      const access = await porthole.access(
        new Request(`${origin}/ws`, { headers: { cookie: `${name}=${value}`, ...headers } }),
      );
      expect(access !== null, who).toBe(goes);
    }
  });

  it("the entry page's session check answers the app's own origin only", async () => {
    const { porthole } = server();
    const { origin, name, value } = await enter(porthole, "preview-8");
    const cookie = `${name}=${value}`;
    const at = `${origin}/__porthole/session`;
    expect(
      (await porthole.handle(request(at, { cookie, ...meta("same-origin", "cors", "empty") })))
        ?.status,
    ).toBe(204);
    expect(
      (await porthole.handle(request(at, { cookie, ...meta("same-site", "no-cors", "script") })))
        ?.status,
    ).toBe(403);
  });
});

describe("P0.3 / S6 on Node: nodeHost's socket path checks the same (P101)", () => {
  it("passes the app's own WebSocket to appSocket, and refuses a sibling's", async () => {
    const content = createContentHost<{ readonly id: string }>({
      domain: "content.localhost",
      appOrigins: ["http://localhost:5173"],
      secret: "a test secret that is at least thirty-two bytes long",
      configs: (source) => ({ url: presets.url({ contentOrigins: [source] }) }),
      name: prefixedName("a-"),
      instance: (proposal) =>
        proposal.document.kind === "external"
          ? { scope: proposal.scope, document: { kind: "external", url: "http://127.0.0.1:1/" } }
          : null,
      access: (_instance, viewer) => (viewer === null ? null : { viewer: viewer.id }),
      upstream: () => new Response("app"),
    });
    const issued = (await (
      await content.issue(() => ({ id: "dev" }))(
        new Request("http://localhost:5173/api/frames", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ instance: app("preview9") }),
        }),
      )
    ).json()) as { url: string; origin: string };
    const entered = (await content.fetch(request(issued.url))) as Response;
    const cookie = pairsOf(entered)[0] ?? "";
    expect(cookie).toMatch(/^porthole-/u);
    const sockets: (string | undefined)[] = [];
    const porthole = nodeHost(content, {
      request: (_request, response) => response.end("the app"),
      appSocket: (_access, asked, socket) => {
        sockets.push(asked.headers.origin);
        socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n");
      },
    });
    const listening = createHttpServer(porthole.request);
    listening.on("upgrade", porthole.upgrade);
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    const port = (listening.address() as AddressInfo).port;
    const host = new URL(issued.origin).host;
    const upgrade = (origin: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            `GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\n\r\n`,
          );
        });
        let said = "";
        socket.on("data", (chunk) => (said += String(chunk)));
        socket.on("end", () => resolve(said.split("\r\n")[0] ?? ""));
        socket.on("error", reject);
      });
    try {
      expect(await upgrade(issued.origin)).toBe("HTTP/1.1 101 Switching Protocols");
      expect(await upgrade("http://a-other.content.localhost")).toBe("HTTP/1.1 404 Not Found");
      expect(await upgrade("null")).toBe("HTTP/1.1 404 Not Found");
      expect(sockets).toEqual([issued.origin]);
    } finally {
      listening.close();
    }
  });
});
