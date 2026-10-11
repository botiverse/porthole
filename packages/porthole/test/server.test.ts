import { afterEach, describe, expect, it, vi } from "vitest";
import { presets, type EgressConfig } from "../src/index.ts";
import type { InstanceRef } from "../src/isolation/types.ts";
import { sandboxProxyDocument } from "../src/mcp/proxy.ts";
import {
  createServer,
  memoryTicketStore,
  proxyTo,
  type Access,
  type ServerOptions,
  type Upstream,
} from "../src/server/index.ts";
import { compile } from "../src/compile/compile.ts";

const secret = new Uint8Array(32).fill(7);
const HOST = "https://app.example.com";
const DOMAIN = "example-usercontent.com";
const CONTENT = `https://*.${DOMAIN}`;

const configs = {
  inlineWidget: presets.inlineWidget({ isolation: "domain", contentOrigins: [CONTENT] }),
  artifact: presets.artifact({ isolation: "domain", contentOrigins: [CONTENT] }),
  mcpApp: presets.mcpApp({ isolation: "domain", contentOrigins: [CONTENT] }),
};

const pages: Record<string, string> = {
  "page@1": "<!doctype html><html><body><h1>Version one</h1></body></html>",
  "page@2": "<!doctype html><html><body><h1>Version two</h1></body></html>",
};

function server(extra: Partial<ServerOptions> = {}) {
  return createServer({
    content: { domain: DOMAIN, scheme: "https" },
    secret,
    hostOrigins: [HOST],
    configs,
    artifacts: {
      get: async (id, version) => {
        const html = pages[`${id}@${version}`];
        return html === undefined ? null : { html };
      },
    },
    ...extra,
  });
}

const get = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(url, { method, headers: { "sec-fetch-dest": "iframe", ...headers } });

/** The `name=value` of a response's Set-Cookie, for sending back. */
const cookieOf = (response: Response): string =>
  (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

const shell: InstanceRef = {
  scope: "conversation-1",
  document: { kind: "shell", preset: "inlineWidget" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("origins", () => {
  it("gives each scope a stable, DNS-safe origin of its own under the content domain", () => {
    const a = server();
    const b = server();
    expect(a.originFor("x")).toBe(b.originFor("x"));
    expect(a.originFor("x")).not.toBe(a.originFor("y"));
    expect(a.originFor("x")).toMatch(/^https:\/\/[a-z2-7]{24}\.example-usercontent\.com$/u);
    expect(a.contentSource).toBe(CONTENT);
  });

  it("keys labels with the secret, so they can't be guessed from the scope", () => {
    const other = server({ secret: new Uint8Array(32).fill(8) });
    expect(other.originFor("x")).not.toBe(server().originFor("x"));
  });

  it("keeps a non-default port and drops a default one", () => {
    const dev = createServer({
      content: { domain: "localhost", scheme: "http", port: 8790 },
      secret,
      hostOrigins: ["http://127.0.0.1:8790"],
      configs: {},
    });
    expect(dev.originFor("x")).toMatch(/^http:\/\/[a-z2-7]{24}\.localhost:8790$/u);
    expect(dev.contentSource).toBe("http://*.localhost:8790");
    const tls = createServer({
      content: { domain: DOMAIN, scheme: "https", port: 443 },
      secret,
      hostOrigins: [HOST],
      configs: {},
    });
    expect(tls.originFor("x")).not.toContain(":443");
  });
});

describe("createServer refuses an unsafe setup", () => {
  const base = {
    content: { domain: DOMAIN, scheme: "https" as const },
    secret,
    hostOrigins: [HOST],
    configs: {},
  };

  it("needs a secret of at least 32 bytes", () => {
    expect(() => createServer({ ...base, secret: new Uint8Array(16) })).toThrow(/32/u);
  });

  it("serves over https except on localhost", () => {
    expect(() => createServer({ ...base, content: { domain: DOMAIN, scheme: "http" } })).toThrow(
      /localhost/u,
    );
  });

  it("refuses a host that may share a site with the content", () => {
    expect(() =>
      createServer({ ...base, content: { domain: "usercontent.example.com", scheme: "https" } }),
    ).toThrow(/same site/u);
    expect(() => createServer({ ...base, hostOrigins: [`https://app.${DOMAIN}`] })).toThrow(
      /same site/u,
    );
    expect(() => createServer({ ...base, hostOrigins: ["https://app.example.com/path"] })).toThrow(
      /exact origin/u,
    );
  });

  it("refuses to issue under a config that isn't domain isolation or doesn't name this server", async () => {
    const opaque = createServer({ ...base, configs: { inlineWidget: presets.inlineWidget() } });
    await expect(opaque.issue(shell, { viewer: "v" })).rejects.toThrow(/domain isolation/u);
    const elsewhere = createServer({
      ...base,
      configs: {
        inlineWidget: presets.inlineWidget({
          isolation: "domain",
          contentOrigins: ["https://*.other.com"],
        }),
      },
    });
    await expect(elsewhere.issue(shell, { viewer: "v" })).rejects.toThrow(/contentOrigins/u);
    await expect(
      server().issue({ scope: "x", document: { kind: "shell", preset: "nope" } }, { viewer: "v" }),
    ).rejects.toThrow(/No config/u);
  });
});

describe("routing", () => {
  it("leaves every request off the content domain to the host", async () => {
    expect(await server().handle(new Request("https://app.example.com/"))).toBeNull();
    expect(
      await server().handle(new Request("https://example-usercontent.com.evil.com/")),
    ).toBeNull();
  });

  it("answers the bare domain, deeper names and malformed labels itself, with nothing", async () => {
    for (const url of [
      `https://${DOMAIN}/`,
      `https://a.b.${DOMAIN}/`,
      `https://nolabel.${DOMAIN}/`,
    ]) {
      const response = await server().handle(get(url));
      expect(response?.status).toBe(404);
      expect(response?.headers.get("content-security-policy")).toContain(`frame-ancestors ${HOST}`);
    }
  });
});

describe("tickets and cookies", () => {
  it("serves the document with the ticket's own answer, its CSP and frame-ancestors in headers", async () => {
    const porthole = server();
    const location = await porthole.issue(shell, { viewer: "person-1" });
    expect(location.origin).toBe(porthole.originFor("conversation-1"));
    expect(location.url).toMatch(/\/__porthole\/d\/[a-z2-7]{16}\?ticket=pt_[a-z2-7]+$/u);
    const response = await porthole.handle(get(location.url));
    expect(response?.status).toBe(200);
    const csp = response?.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(`${compile(configs.inlineWidget).csp}; frame-ancestors ${HOST}`);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    const body = (await response?.text()) ?? "";
    expect(body).toContain('id="porthole-root"');
    expect(body).not.toContain("Content-Security-Policy");
    expect(body).not.toContain("person-1");
  });

  it("sets a cookie of that origin only: __Host-, HttpOnly, partitioned in a frame", async () => {
    const porthole = server();
    const response = await porthole.handle(get((await porthole.issue(shell, { viewer: "v" })).url));
    const cookie = response?.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-porthole-[a-z2-7]{16}=/u);
    expect(cookie).toContain("; Path=/");
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; Secure; SameSite=None; Partitioned");
    expect(cookie).toContain("; Max-Age=3600");
    expect(cookie).not.toMatch(/Domain=/iu);
  });

  it("makes the cookie Lax and unpartitioned on a tab of its own", async () => {
    const porthole = server();
    const response = await porthole.handle(
      get((await porthole.issue(shell, { viewer: "v", sessionSeconds: 60 })).url, {
        "sec-fetch-dest": "document",
      }),
    );
    const cookie = response?.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("; Secure; SameSite=Lax");
    expect(cookie).toContain("; Max-Age=60");
    expect(cookie).not.toContain("Partitioned");
  });

  it("drops the __Host- prefix and Secure on a top-level http dev origin", async () => {
    const dev = createServer({
      content: { domain: "localhost", scheme: "http", port: 8790 },
      secret,
      hostOrigins: ["http://127.0.0.1:8790"],
      configs: {
        inlineWidget: presets.inlineWidget({
          isolation: "domain",
          contentOrigins: ["http://*.localhost:8790"],
        }),
      },
    });
    const url = (await dev.issue(shell, { viewer: "v" })).url;
    const cookie =
      (await dev.handle(get(url, { "sec-fetch-dest": "document" })))?.headers.get("set-cookie") ??
      "";
    expect(cookie).toMatch(/^porthole-[a-z2-7]{16}=/u);
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
  });

  it("takes a ticket once: a second load without the cookie gets nothing of the content", async () => {
    const porthole = server();
    const { url } = await porthole.issue(shell, { viewer: "v" });
    expect((await porthole.handle(get(url)))?.status).toBe(200);
    const again = await porthole.handle(get(url));
    expect(again?.status).toBe(401);
    expect(await again?.text()).not.toContain("porthole-root");
  });

  it("lets the cookie reload the same instance, and only that one", async () => {
    const porthole = server();
    const { url } = await porthole.issue(shell, { viewer: "v" });
    const first = await porthole.handle(get(url));
    const cookie = cookieOf(first as Response);
    const reload = await porthole.handle(get(url, { cookie }));
    expect(reload?.status).toBe(200);
    expect(reload?.headers.get("set-cookie")).toBeNull();
    // Another instance on the same origin (same scope) needs its own ticket.
    const other = await porthole.issue(
      { scope: "conversation-1", document: { kind: "artifact", id: "page", version: "1" } },
      { viewer: "v" },
    );
    const bare = other.url.replace(/\?.*$/u, "");
    expect((await porthole.handle(get(bare, { cookie })))?.status).toBe(401);
  });

  it("refuses a tampered cookie, and one carried to another origin", async () => {
    const porthole = server();
    const { url } = await porthole.issue(shell, { viewer: "v" });
    const cookie = cookieOf((await porthole.handle(get(url))) as Response);
    const bare = url.replace(/\?.*$/u, "");
    const [name, value = ""] = cookie.split("=");
    const [payload = "", signature = ""] = value.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        w: "someone-else",
      }),
    ).toString("base64url");
    expect(
      (await porthole.handle(get(bare, { cookie: `${name}=${forged}.${signature}` })))?.status,
    ).toBe(401);
    const elsewhere = bare.replace(
      porthole.originFor("conversation-1"),
      porthole.originFor("conversation-2"),
    );
    expect((await porthole.handle(get(elsewhere, { cookie })))?.status).toBe(401);
  });

  it("refuses an expired ticket and an expired cookie", async () => {
    vi.useFakeTimers();
    const porthole = server();
    const late = await porthole.issue(shell, { viewer: "v", ttlSeconds: 5 });
    vi.advanceTimersByTime(6_000);
    expect((await porthole.handle(get(late.url)))?.status).toBe(401);
    const { url } = await porthole.issue(shell, { viewer: "v", sessionSeconds: 10 });
    const cookie = cookieOf((await porthole.handle(get(url))) as Response);
    vi.advanceTimersByTime(11_000);
    expect((await porthole.handle(get(url, { cookie })))?.status).toBe(401);
  });

  it("burns a ticket used on the wrong origin or for another instance", async () => {
    const porthole = server();
    const { url } = await porthole.issue(shell, { viewer: "v" });
    const elsewhere = url.replace(
      porthole.originFor("conversation-1"),
      porthole.originFor("conversation-2"),
    );
    expect((await porthole.handle(get(elsewhere)))?.status).toBe(401);
    expect((await porthole.handle(get(url)))?.status).toBe(401);
  });

  it("serves HEAD without redeeming, and refuses writes", async () => {
    const porthole = server();
    const { url } = await porthole.issue(shell, { viewer: "v" });
    expect((await porthole.handle(get(url, {}, "HEAD")))?.status).toBe(401);
    expect((await porthole.handle(get(url, {}, "POST")))?.status).toBe(405);
    expect((await porthole.handle(get(url)))?.status).toBe(200);
  });

  it("stores only a ticket's hash", async () => {
    const ids: string[] = [];
    const store = memoryTicketStore();
    const porthole = server({
      tickets: {
        put: async (id, record) => {
          ids.push(id);
          await store.put(id, record);
        },
        take: (id) => store.take(id),
      },
    });
    const { url } = await porthole.issue(shell, { viewer: "v" });
    const ticket = new URL(url).searchParams.get("ticket") ?? "";
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toContain(ticket);
  });

  it("checks grants", async () => {
    await expect(server().issue(shell, { viewer: "" })).rejects.toThrow(/viewer/u);
    await expect(server().issue(shell, { viewer: "v", ttlSeconds: 0 })).rejects.toThrow(
      /ttlSeconds/u,
    );
    await expect(server().issue(shell, { viewer: "v", sessionSeconds: 1.5 })).rejects.toThrow(
      /sessionSeconds/u,
    );
    await expect(
      server().issue({ scope: "", document: shell.document }, { viewer: "v" }),
    ).rejects.toThrow(/scope/u);
  });
});

describe("artifact pages", () => {
  it("serves each version as stored, hardened by the shell, and nothing for an unknown one", async () => {
    const porthole = server();
    const at = (version: string) =>
      porthole.issue(
        { scope: "files", document: { kind: "artifact", id: "page", version } },
        { viewer: "v" },
      );
    const one = await (await porthole.handle(get((await at("1")).url)))?.text();
    const two = await (await porthole.handle(get((await at("2")).url)))?.text();
    expect(one).toContain("Version one");
    expect(two).toContain("Version two");
    expect(one?.indexOf("<script>")).toBeLessThan(one?.indexOf("Version one") ?? 0);
    expect((await porthole.handle(get((await at("3")).url)))?.status).toBe(404);
  });

  it("needs an artifact store", async () => {
    await expect(
      createServer({
        content: { domain: DOMAIN, scheme: "https" },
        secret,
        hostOrigins: [HOST],
        configs,
      }).issue(
        { scope: "s", document: { kind: "artifact", id: "a", version: "1" } },
        { viewer: "v" },
      ),
    ).rejects.toThrow(/artifacts/u);
  });
});

describe("the MCP Apps sandbox proxy", () => {
  const proxy = (egress?: EgressConfig): InstanceRef => ({
    scope: "app-1",
    document: { kind: "mcp-proxy", ...(egress === undefined ? {} : { egress }) },
  });

  it("goes out with the view's declared egress in its CSP header", async () => {
    const porthole = server();
    const { url } = await porthole.issue(
      proxy({ connect: ["https://api.example.org"], img: ["https://tiles.example.org"] }),
      { viewer: "v" },
    );
    const response = await porthole.handle(get(url));
    const csp = response?.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src https://api.example.org;");
    expect(csp).toContain("https://tiles.example.org");
    expect(csp).toContain("frame-src 'none'");
    expect(await response?.text()).toContain("ui/notifications/sandbox-proxy-ready");
  });

  it("keeps egress closed when the view declares none", async () => {
    const porthole = server();
    const response = await porthole.handle(
      get((await porthole.issue(proxy(), { viewer: "v" })).url),
    );
    expect(response?.headers.get("content-security-policy")).toContain("connect-src 'none'");
  });

  it("refuses a malformed egress before minting a ticket", async () => {
    await expect(
      server().issue(proxy({ connect: ["https://api.example.org; script-src *"] }), {
        viewer: "v",
      }),
    ).rejects.toThrow(/not an origin/u);
  });

  it("becomes exactly the shell-hardened view", () => {
    const compiled = compile(configs.mcpApp);
    const document = sandboxProxyDocument(compiled, [HOST]);
    const setup = /const setup = (\{.*\});/u.exec(document)?.[1] ?? "{}";
    const { shell: page, slot } = JSON.parse(setup) as { shell: string; slot: string };
    const view = "<html><body>view</body><script>x = '</script>'\u2028</script></html>";
    // What the proxy's runtime does with the view: its JSON literal, safe inside a <script>.
    const literal = JSON.stringify(view)
      .replace(/</gu, "\\u003c")
      .replace(/\u2028/gu, "\\u2028")
      .replace(/\u2029/gu, "\\u2029");
    expect(page.replace(slot, () => literal)).toBe(
      compiled.shellDocument({ origins: [HOST], document: view, cspMeta: false }),
    );
    expect(() => sandboxProxyDocument(compile(configs.artifact), [HOST])).toThrow(/MCP Apps/u);
  });
});

describe("url mode", () => {
  const app: InstanceRef = {
    scope: "preview-1",
    document: { kind: "external", url: "http://localhost:5173/dash?x=1" },
  };

  function withUpstream() {
    const calls: { request: Request; access: Access }[] = [];
    const upstream: Upstream = (request, access) => {
      calls.push({ request, access });
      return new Response("app", {
        headers: [
          ["set-cookie", "theirs=1; Path=/"],
          ["set-cookie", "__Host-porthole-aaaaaaaaaaaaaaaa=stolen; Path=/"],
        ],
      });
    };
    return { calls, porthole: server({ upstream }) };
  }

  it("trades the ticket for a cookie and lands on the app's own path", async () => {
    const { porthole } = withUpstream();
    const location = await porthole.issue(app, { viewer: "dev" });
    expect(location.url).toMatch(/\/__porthole\/enter\?ticket=/u);
    const entered = await porthole.handle(get(location.url));
    expect(entered?.status).toBe(303);
    expect(entered?.headers.get("location")).toBe("/dash?x=1");
    expect(entered?.headers.get("set-cookie")).toContain("Partitioned");
    expect((await porthole.handle(get(location.url)))?.status).toBe(403);
  });

  it("lets the cookie through to the upstream, without Porthole's cookies", async () => {
    const { porthole, calls } = withUpstream();
    const location = await porthole.issue(app, { viewer: "dev" });
    const cookie = cookieOf((await porthole.handle(get(location.url))) as Response);
    const response = await porthole.handle(
      get(`${location.origin}/src/main.ts`, { cookie: `${cookie}; theirs=1` }),
    );
    expect(await response?.text()).toBe("app");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.access.viewer).toBe("dev");
    expect(calls[0]?.access.origin).toBe(location.origin);
    expect(calls[0]?.request.headers.get("cookie")).toBe("theirs=1");
    expect(response?.headers.getSetCookie()).toEqual(["theirs=1; Path=/"]);
    expect(response?.headers.get("content-security-policy")).toBe(`frame-ancestors ${HOST}`);
    expect((await porthole.access(get(`${location.origin}/`, { cookie })))?.viewer).toBe("dev");
  });

  it("gives nothing of the app without the cookie", async () => {
    const { porthole, calls } = withUpstream();
    const location = await porthole.issue(app, { viewer: "dev" });
    const response = await porthole.handle(get(`${location.origin}/`));
    expect(response?.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(await porthole.access(get(`${location.origin}/`))).toBeNull();
  });

  it("needs an upstream, and an http(s) url", async () => {
    await expect(server().issue(app, { viewer: "v" })).rejects.toThrow(/upstream/u);
    await expect(
      withUpstream().porthole.issue(
        { scope: "s", document: { kind: "external", url: "file:///etc/passwd" } },
        { viewer: "v" },
      ),
    ).rejects.toThrow(/http/u);
  });
});

describe("proxyTo", () => {
  it("tells the app it is on its own origin and nothing of the proxy", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const relay = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("<p>hi</p>", {
        status: 302,
        headers: [
          ["location", "http://localhost:5173/login"],
          ["set-cookie", "sid=1; Domain=localhost; Path=/"],
          ["content-encoding", "gzip"],
          ["connection", "close"],
        ],
      });
    }) as unknown as typeof fetch;
    const upstream = proxyTo({ fetch: relay });
    const origin = "https://abc.example-usercontent.com";
    const response = await upstream(
      new Request(`${origin}/a/b?c=d`, {
        headers: {
          origin,
          referer: `${origin}/page`,
          "x-forwarded-for": "1.2.3.4",
          cookie: "theirs=1",
        },
      }),
      {
        instance: { scope: "s", document: { kind: "external", url: "http://localhost:5173/" } },
        viewer: "v",
        origin,
        expiresAt: 0,
      },
    );
    expect(seen[0]?.url).toBe("http://localhost:5173/a/b?c=d");
    const headers = new Headers(seen[0]?.init.headers);
    expect(headers.get("origin")).toBe("http://localhost:5173");
    expect(headers.get("referer")).toBe("http://localhost:5173/page");
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("cookie")).toBe("theirs=1");
    expect(seen[0]?.init.redirect).toBe("manual");
    expect(response.headers.get("location")).toBe(`${origin}/login`);
    expect(response.headers.getSetCookie()).toEqual(["sid=1; Path=/"]);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("connection")).toBeNull();
  });
});
