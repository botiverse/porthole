import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { presets, type EgressConfig } from "../src/index.ts";
import type { InstanceRef } from "../src/isolation/types.ts";
import { sandboxProxyDocument } from "../src/mcp/proxy.ts";
import {
  createServer,
  d1TicketSchema,
  d1TicketStore,
  isHostLabel,
  memoryTicketStore,
  prefixedName,
  proxyTo,
  type Access,
  type AuthorizeRequest,
  type D1Like,
  type D1StatementLike,
  type ServerOptions,
  type TicketRecord,
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
  artifactNested: presets.artifact({
    isolation: "domain",
    contentOrigins: [CONTENT],
    nested: true,
  }),
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
    // With the frame's own sandbox (P099): the same in its frame, the only one on a tab.
    expect(csp).toBe(
      `${compile(configs.inlineWidget).csp}; sandbox allow-scripts allow-same-origin; frame-ancestors ${HOST}`,
    );
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    const body = (await response?.text()) ?? "";
    expect(body).toContain('id="porthole-root"');
    expect(body).not.toContain("Content-Security-Policy");
    expect(body).not.toContain("person-1");
  });

  it("sandboxes every served page as its frame is, on a tab of its own too (P099, S4)", async () => {
    const porthole = server();
    const artifact: InstanceRef = {
      scope: "conversation-1",
      document: { kind: "artifact", id: "page", version: "1" },
    };
    const proxied: InstanceRef = { scope: "app-1", document: { kind: "mcp-proxy" } };
    for (const instance of [shell, artifact, proxied]) {
      // In a frame, on a tab, and from a client that sends no fetch metadata at all.
      for (const headers of [
        { "sec-fetch-dest": "iframe" },
        { "sec-fetch-dest": "document" },
        { "sec-fetch-dest": "" },
      ]) {
        const { url } = await porthole.issue(instance, { viewer: "v" });
        const response = await porthole.handle(
          new Request(url, {
            headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== "")),
          }),
        );
        expect(response?.status, instance.document.kind).toBe(200);
        const directives = (response?.headers.get("content-security-policy") ?? "")
          .split(";")
          .map((each) => each.trim());
        expect(directives, instance.document.kind).toContain(
          "sandbox allow-scripts allow-same-origin",
        );
        expect(directives.filter((each) => each.startsWith("sandbox"))).toHaveLength(1);
        expect(directives.join("; ")).not.toMatch(/allow-(popups|forms|downloads|modals|top)/u);
        // And what its frame's allow doesn't grant, denied there too.
        const permissions = response?.headers.get("permissions-policy") ?? "";
        expect(permissions, instance.document.kind).toContain("camera=()");
        expect(permissions).toContain("geolocation=()");
        expect(permissions).toContain("fullscreen=()");
      }
    }
    // Porthole's own pages (a refusal) are not content, and keep their own policy.
    const refused = await porthole.handle(
      get(`${porthole.originFor("conversation-1")}/__porthole/d/aaaaaaaaaaaaaaaa`),
    );
    expect(refused?.headers.get("content-security-policy")).not.toContain("allow-same-origin");
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
    const { url, door } = await porthole.issue(shell, { viewer: "v" });
    const ticket = new URL(url).searchParams.get("ticket") ?? "";
    const doorTicket = new URL(door?.url ?? "https://x.invalid/").searchParams.get("ticket") ?? "";
    // The content's ticket and its door's (P125), each stored by its hash alone.
    expect(ids).toHaveLength(2);
    expect(doorTicket).not.toBe("");
    for (const id of ids) {
      expect(id).not.toContain(ticket);
      expect(id).not.toContain(doorTicket);
    }
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

describe("a served display's door (P125)", () => {
  const artifact: InstanceRef = {
    scope: "conversation-1",
    document: { kind: "artifact", id: "page", version: "1" },
  };
  const proxied: InstanceRef = { scope: "app-1", document: { kind: "mcp-proxy" } };
  const nested: InstanceRef = {
    scope: "nest-1",
    document: { kind: "artifact", id: "page", version: "1", preset: "artifactNested" },
  };

  const doorOf = (location: { readonly door?: { readonly url: string } }): string => {
    expect(location.door, "a served non-nested display has a door").toBeDefined();
    return location.door!.url;
  };

  it("issue mints a door for a shell, a page and the proxy, on the same origin, not for nested or url", async () => {
    const porthole = server({ upstream: proxyTo({ target: () => "https://app.test" }) });
    for (const instance of [shell, artifact, proxied]) {
      const location = await porthole.issue(instance, { viewer: "v" });
      const url = new URL(doorOf(location));
      expect(url.origin).toBe(location.origin);
      expect(url.pathname).toMatch(/^\/__porthole\/door\/[a-z2-7]{16}$/u);
      // Its key is the instance's, as the content's address is.
      expect(url.pathname.split("/").at(-1)).toBe(new URL(location.url).pathname.split("/").at(-1));
    }
    expect(
      (await porthole.issue(nested, { viewer: "v" })).door,
      "a nested page has no door: its shell is Porthole's own first document",
    ).toBeUndefined();
    const app = await porthole.issue(
      { scope: "app-2", document: { kind: "external", url: "https://app.test/" } },
      { viewer: "v" },
    );
    expect(app.door, "a url-mode app has no door").toBeUndefined();
  });

  it("the door takes its own ticket once and answers open, with its CSP and no cookie", async () => {
    const porthole = server();
    const location = await porthole.issue(shell, { viewer: "v" });
    const door = doorOf(location);
    const response = await porthole.handle(get(door));
    expect(response?.status).toBe(200);
    const csp = response?.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(
      /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; base-uri 'none'; form-action 'none'; sandbox allow-scripts; frame-ancestors /u,
    );
    expect(csp).toContain(`frame-ancestors ${HOST}`);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("set-cookie"), "the door sets no cookie").toBeNull();
    const body = (await response?.text()) ?? "";
    expect(body).toContain("data-porthole-door");
    expect(body).not.toContain("allow-same-origin");
    // Used once.
    expect((await porthole.handle(get(door)))?.status).toBe(401);
  });

  it("the door reports the host's deny with its code, and a not-found", async () => {
    const revoked = new Set<string>();
    const porthole = server({
      authorize: {
        check: ({ subject }) =>
          subject !== undefined && revoked.has(subject)
            ? { allow: false, code: "revoked" }
            : { allow: true },
      },
    });
    revoked.add("gone");
    const denied = await porthole.issue(artifact, { viewer: "v", subject: "gone" });
    const response = await porthole.handle(get(doorOf(denied)));
    expect(response?.status).toBe(403);
    const body = (await response?.text()) ?? "";
    expect(body).toContain('data-porthole-reason="denied"');
    expect(body).toContain('data-porthole-code="revoked"');
    // A page that doesn't exist: not-found.
    const missing = await porthole.issue(
      { scope: "c", document: { kind: "artifact", id: "page", version: "99" } },
      { viewer: "v" },
    );
    expect((await porthole.handle(get(doorOf(missing))))?.status).toBe(404);
  });

  it("the door refuses a content ticket, and the content route refuses a door ticket", async () => {
    const porthole = server();
    const location = await porthole.issue(shell, { viewer: "v" });
    const contentTicket = new URL(location.url).searchParams.get("ticket") ?? "";
    const doorUrl = new URL(doorOf(location));
    // The door with the content's ticket: no.
    doorUrl.searchParams.set("ticket", contentTicket);
    expect((await porthole.handle(get(doorUrl.href)))?.status).toBe(401);
    // The content route with the door's ticket: no (and the content still has its own ticket).
    const other = await porthole.issue(shell, { viewer: "v" });
    const doorTicket = new URL(doorOf(other)).searchParams.get("ticket") ?? "";
    const contentUrl = new URL(other.url);
    contentUrl.searchParams.set("ticket", doorTicket);
    const refused = await porthole.handle(get(contentUrl.href));
    expect(refused?.status).toBe(401);
  });

  /** A status page's word: its status, `data-porthole-reason` and `data-porthole-code`. */
  const wordOf = async (response: Response | null) => {
    const body = (await response?.text()) ?? "";
    return {
      status: response?.status,
      reason: /data-porthole-reason="([a-z-]+)"/u.exec(body)?.[1],
      code: /data-porthole-code="([a-z0-9-]+)"/u.exec(body)?.[1],
    };
  };

  /** One issue's door ticket at the door route, and its content ticket at `/__porthole/d/`. */
  const bothRoutes = async (
    porthole: ReturnType<typeof server>,
    location: { readonly url: string; readonly door?: { readonly url: string } },
  ) => ({
    door: await wordOf(await porthole.handle(get(doorOf(location)))),
    content: await wordOf(await porthole.handle(get(location.url))),
  });

  describe("the door answers the same block the content route would, for the same grant (Cato's check)", () => {
    it("denied, with the host's code", async () => {
      const revoked = new Set<string>(["gone"]);
      const porthole = server({
        authorize: {
          check: ({ subject }) =>
            subject !== undefined && revoked.has(subject)
              ? { allow: false, code: "revoked" }
              : { allow: true },
        },
      });
      const location = await porthole.issue(artifact, { viewer: "v", subject: "gone" });
      const { door, content } = await bothRoutes(porthole, location);
      expect(door).toEqual({ status: 403, reason: "denied", code: "revoked" });
      expect(content).toEqual(door);
    });

    it("session: each ticket already used once", async () => {
      const porthole = server();
      const location = await porthole.issue(shell, { viewer: "v" });
      // The same issue's two tickets, each taken once at its own route...
      expect((await porthole.handle(get(doorOf(location))))?.status).toBe(200);
      expect((await porthole.handle(get(location.url)))?.status).toBe(200);
      // ...and again: both used. (No cookie is sent back, as a fresh frame would have none.)
      const { door, content } = await bothRoutes(porthole, location);
      expect(door).toEqual({ status: 401, reason: "session", code: undefined });
      expect(content).toEqual(door);
    });

    it("not-found: a document that doesn't exist", async () => {
      const porthole = server();
      const location = await porthole.issue(
        { scope: "c", document: { kind: "artifact", id: "page", version: "99" } },
        { viewer: "v" },
      );
      const { door, content } = await bothRoutes(porthole, location);
      expect(door).toEqual({ status: 404, reason: "not-found", code: undefined });
      expect(content).toEqual(door);
    });

    it("not-found: a file set whose entry isn't a page", async () => {
      const porthole = server({
        artifacts: {
          get: () =>
            Promise.resolve({
              files: { "note.txt": { size: 4, sha256: "0".repeat(64) } },
              entry: "note.txt",
              read: () => Promise.resolve(new TextEncoder().encode("note")),
            }),
        },
      });
      const location = await porthole.issue(artifact, { viewer: "v" });
      const { door, content } = await bothRoutes(porthole, location);
      expect(door).toEqual({ status: 404, reason: "not-found", code: undefined });
      expect(content).toEqual(door);
    });
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

  it("trades the ticket for a cookie: a tab lands on the app's own path", async () => {
    const { porthole } = withUpstream();
    const location = await porthole.issue(app, { viewer: "dev" });
    expect(location.url).toMatch(/\/__porthole\/enter\?ticket=/u);
    expect(location.reports).toBe(true);
    const entered = await porthole.handle(get(location.url, { "sec-fetch-dest": "document" }));
    expect(entered?.status).toBe(303);
    expect(entered?.headers.get("location")).toBe("/dash?x=1");
    expect(entered?.headers.get("set-cookie")).toContain("SameSite=Lax");
    const again = await porthole.handle(get(location.url));
    expect(again?.status).toBe(403);
    expect(await again?.text()).toContain('data-porthole-reason="session"');
  });

  it("enters a framed app through a page that checks the cookie was kept, and says so", async () => {
    const { porthole } = withUpstream();
    const location = await porthole.issue(app, { viewer: "dev" });
    const entered = (await porthole.handle(get(location.url))) as Response;
    expect(entered.status).toBe(200);
    expect(entered.headers.get("set-cookie")).toContain("Partitioned");
    expect(entered.headers.get("content-security-policy")).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${HOST}`,
    );
    const html = await entered.text();
    expect(html).toContain('data-porthole-target="/dash?x=1"');
    expect(html).toContain(`data-porthole-hosts="[&#34;${HOST}&#34;]"`);
    expect(html).toContain('<script src="/__porthole/enter.js"></script>');
    // The session check the page makes: the kept cookie opens the app; none doesn't.
    const cookie = cookieOf(entered);
    expect(
      (await porthole.handle(get(`${location.origin}/__porthole/session`, { cookie })))?.status,
    ).toBe(204);
    expect((await porthole.handle(get(`${location.origin}/__porthole/session`)))?.status).toBe(401);
    const script = (await porthole.handle(
      get(`${location.origin}/__porthole/enter.js`),
    )) as Response;
    expect(script.headers.get("content-type")).toContain("javascript");
    const text = await script.text();
    expect(text).toContain("porthole/notifications/frame-status");
    // It leaves for the app only after its own load, which the host counts (P040).
    expect(text.indexOf('addEventListener("load"')).toBeLessThan(text.indexOf("location.replace"));
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
    // The app's own document: its tab is the app's (P099).
    expect(response?.headers.get("permissions-policy")).toBeNull();
    expect((await porthole.access(get(`${location.origin}/`, { cookie })))?.viewer).toBe("dev");
  });

  it("gives nothing of the app without the cookie, and tells the host why", async () => {
    const { porthole, calls } = withUpstream();
    const location = await porthole.issue(app, { viewer: "dev" });
    const response = await porthole.handle(get(`${location.origin}/`));
    expect(response?.status).toBe(401);
    expect(await response?.text()).toContain('data-porthole-reason="session"');
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

describe("a host's own names (P047)", () => {
  const flat = (extra: Partial<ServerOptions> = {}) =>
    server({
      content: {
        domain: DOMAIN,
        scheme: "https",
        name: prefixedName("a-"),
        reserved: ["f", "www"],
      },
      ...extra,
    });
  const page1: InstanceRef = {
    scope: "101",
    document: { kind: "artifact", id: "page", version: "1" },
  };

  it("serves each scope on the name the host gives it", async () => {
    const porthole = flat();
    expect(porthole.originFor("101")).toBe(`https://a-101.${DOMAIN}`);
    const location = await porthole.issue(page1, { viewer: "v" });
    expect(location.origin).toBe(`https://a-101.${DOMAIN}`);
    const first = (await porthole.handle(get(location.url))) as Response;
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Version one");
    const reload = get(location.url.replace(/\?ticket=.*/u, ""), { cookie: cookieOf(first) });
    expect((await porthole.handle(reload))?.status).toBe(200);
  });

  it("refuses a ticket on another scope's name", async () => {
    const porthole = flat();
    const location = await porthole.issue(page1, { viewer: "v" });
    const elsewhere = location.url.replace("://a-101.", "://a-102.");
    expect((await porthole.handle(get(elsewhere)))?.status).toBe(401);
    expect((await porthole.handle(get(location.url)))?.status).toBe(401);
  });

  it("takes only one lowercase DNS label that isn't reserved, from the host's naming", () => {
    for (const bad of [
      "A-1",
      "a.b",
      "",
      "-a",
      "a-",
      "xn--bcher-kva",
      "ab--c",
      "f",
      "www",
      "a".repeat(64),
    ]) {
      const porthole = server({
        content: { domain: DOMAIN, scheme: "https", name: () => bad, reserved: ["f", "www"] },
      });
      expect(() => porthole.originFor("x"), bad).toThrow(/content\.name/u);
    }
    const nonString = server({
      content: { domain: DOMAIN, scheme: "https", name: () => 7 as unknown as string },
    });
    expect(() => nonString.originFor("x")).toThrow(/content\.name/u);
    expect(() => server({ content: { domain: DOMAIN, scheme: "https", reserved: ["F"] } })).toThrow(
      /reserved/u,
    );
  });

  it("leaves a reserved namespace and the names under it to the host's routes", async () => {
    const porthole = flat();
    for (const url of [
      `https://f.${DOMAIN}/`,
      `https://x.f.${DOMAIN}/__porthole/session`,
      `https://www.${DOMAIN}/`,
    ]) {
      expect(await porthole.handle(get(url)), url).toBeNull();
      expect(await porthole.access(get(url)), url).toBeNull();
    }
    for (const url of [
      `https://${DOMAIN}/`,
      `https://a-1.b.${DOMAIN}/`,
      `https://xn--bcher-kva.${DOMAIN}/`,
    ]) {
      expect((await porthole.handle(get(url)))?.status, url).toBe(404);
    }
  });

  it("keeps keyed and prefixed names apart: neither can be the other or a reserved one", () => {
    const name = prefixedName("a-");
    expect(name("k3x9")).toBe("a-k3x9");
    expect(name("0f8e2c1a-9b7d-4e1f-8a2b-3c4d5e6f7a8b")).toBe(
      "a-0f8e2c1a-9b7d-4e1f-8a2b-3c4d5e6f7a8b",
    );
    for (const scope of ["", "K3", "a.b", "a_b", "-a", "a-", "x".repeat(62)]) {
      expect(() => name(scope), scope).toThrow(/can't be named/u);
    }
    for (const prefix of ["a", "-", "1-", "A-", "a--", "a.b-"]) {
      expect(() => prefixedName(prefix), prefix).toThrow(/prefix/u);
    }
    // A keyed label is 24 base32 characters, without a hyphen; a prefixed one always has one.
    expect(server().originFor("101")).toMatch(/^https:\/\/[a-z2-7]{24}\./u);
    expect(isHostLabel("a-101")).toBe(true);
    expect(isHostLabel("xn--a-ecp")).toBe(false);
  });
});

describe("anonymous grants (P046)", () => {
  const artifact: InstanceRef = {
    scope: "public-7",
    document: { kind: "artifact", id: "page", version: "2" },
  };

  it("open a public page once per ticket, with a cookie of its origin for reloads", async () => {
    const porthole = server();
    const location = await porthole.issue(artifact, { anonymous: true });
    const first = (await porthole.handle(get(location.url))) as Response;
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Version two");
    expect(cookieOf(first)).toMatch(/^__Host-porthole-/u);
    expect((await porthole.handle(get(location.url)))?.status).toBe(401);
    const reload = get(location.url.replace(/\?ticket=.*/u, ""), { cookie: cookieOf(first) });
    expect((await porthole.handle(reload))?.status).toBe(200);
  });

  it("don't open another instance, and never a url-mode app", async () => {
    const porthole = server();
    const location = await porthole.issue(artifact, { anonymous: true });
    const cookie = cookieOf((await porthole.handle(get(location.url))) as Response);
    const other = await porthole.issue(
      { ...artifact, document: { kind: "artifact", id: "page", version: "1" } },
      { anonymous: true },
    );
    expect(
      (await porthole.handle(get(other.url.replace(/\?ticket=.*/u, ""), { cookie })))?.status,
    ).toBe(401);
    const withApp = server({ upstream: () => new Response("app") });
    await expect(
      withApp.issue(
        { scope: "s", document: { kind: "external", url: "http://localhost:5173/" } },
        {
          anonymous: true,
        },
      ),
    ).rejects.toThrow(/anonymously/u);
    await expect(
      porthole.issue(artifact, { anonymous: true, viewer: "v" } as unknown as Parameters<
        typeof porthole.issue
      >[1]),
    ).rejects.toThrow(/no viewer/u);
  });
});

describe("the host's check on every request (P050)", () => {
  const artifact: InstanceRef = {
    scope: "shared-1",
    document: { kind: "artifact", id: "page", version: "1" },
  };
  const revocable = (ttlSeconds?: number) => {
    const revoked = new Set<string>();
    const seen: AuthorizeRequest[] = [];
    const porthole = server({
      authorize: {
        check: (request) => {
          seen.push(request);
          return request.subject !== undefined && revoked.has(request.subject)
            ? { allow: false, code: "revoked" }
            : { allow: true };
        },
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      },
    });
    return { porthole, revoked, seen };
  };

  it("carries the host's opaque subject from issue through the ticket and the cookie", async () => {
    const { porthole, seen } = revocable();
    const subject = 'share:9 ✓ {"any": "thing"}';
    const location = await porthole.issue(artifact, { viewer: "person-1", subject });
    const first = (await porthole.handle(get(location.url))) as Response;
    const reload = get(location.url.replace(/\?ticket=.*/u, ""), { cookie: cookieOf(first) });
    await porthole.handle(reload);
    expect(seen.map((each) => each.subject)).toEqual([subject, subject]);
    expect(seen[1]).toMatchObject({ scope: "shared-1", viewer: "person-1", anonymous: false });
    expect(seen[1]?.instance).toEqual(artifact);
    expect(seen[1]?.request).toBe(reload);
    await expect(
      porthole.issue(artifact, { viewer: "v", subject: "x".repeat(513) }),
    ).rejects.toThrow(/subject/u);
    await expect(
      porthole.issue(artifact, { viewer: "v", subject: 7 as unknown as string }),
    ).rejects.toThrow(/subject/u);
  });

  it("takes effect on the next request: a revoked subject's live cookie gets a denied page", async () => {
    const { porthole, revoked } = revocable();
    const location = await porthole.issue(artifact, { viewer: "v", subject: "share-9" });
    const cookie = cookieOf((await porthole.handle(get(location.url))) as Response);
    const reload = () => get(location.url.replace(/\?ticket=.*/u, ""), { cookie });
    expect((await porthole.handle(reload()))?.status).toBe(200);
    revoked.add("share-9");
    const denied = (await porthole.handle(reload())) as Response;
    expect(denied.status).toBe(403);
    const html = await denied.text();
    expect(html).toContain('data-porthole-reason="denied" data-porthole-code="revoked"');
    expect(html).not.toContain("Version one");
  });

  it("denies a ticket's own first load, and an app's every request, before the upstream", async () => {
    const calls: Request[] = [];
    const revoked = new Set(["s-1"]);
    const porthole = server({
      upstream: (request) => {
        calls.push(request);
        return new Response("app");
      },
      authorize: { check: ({ subject }) => ({ allow: !revoked.has(subject ?? "") }) },
    });
    const page1 = await porthole.issue(artifact, { viewer: "v", subject: "s-1" });
    const first = (await porthole.handle(get(page1.url))) as Response;
    expect(first.status).toBe(403);
    expect(first.headers.get("set-cookie")).toBeNull();
    const app: InstanceRef = {
      scope: "app-1",
      document: { kind: "external", url: "http://localhost:5173/" },
    };
    const entry = await porthole.issue(app, { viewer: "v", subject: "s-2" });
    const entered = (await porthole.handle(get(entry.url))) as Response;
    expect(entered.status).toBe(200);
    const cookie = cookieOf(entered);
    const session = () => get(`${entry.origin}/__porthole/session`, { cookie });
    expect(await (await porthole.handle(get(`${entry.origin}/x`, { cookie })))?.text()).toBe("app");
    expect((await porthole.handle(session()))?.status).toBe(204);
    expect((await porthole.access(get(`${entry.origin}/ws`, { cookie })))?.subject).toBe("s-2");
    revoked.add("s-2");
    const denied = (await porthole.handle(get(`${entry.origin}/x`, { cookie }))) as Response;
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('data-porthole-reason="denied"');
    expect((await porthole.handle(session()))?.status).toBe(403);
    expect(await porthole.access(get(`${entry.origin}/ws`, { cookie }))).toBeNull();
    expect(calls).toHaveLength(1);
    const late = await porthole.issue(app, { viewer: "v", subject: "s-2" });
    expect((await porthole.handle(get(late.url)))?.status).toBe(403);
  });

  it("denies without a reason when the check throws, answers anything but an allow, or gives a malformed code", async () => {
    for (const check of [
      () => {
        throw new Error("down");
      },
      () => ({ allow: false as const, code: "Not A Code!" }),
      () => Promise.reject(new Error("down")),
      () => ({ allow: "yes" }) as unknown as { allow: true },
      () => undefined as unknown as { allow: true },
    ]) {
      const porthole = server({ authorize: { check } });
      const location = await porthole.issue(artifact, { viewer: "v" });
      const response = (await porthole.handle(get(location.url))) as Response;
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain('data-porthole-reason="denied"');
      expect(html).not.toContain("data-porthole-code");
    }
  });

  it("asks every time by default, and reuses an answer only for the host's own short TTL", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    const fresh = revocable();
    const a = await fresh.porthole.issue(artifact, { viewer: "v", subject: "s" });
    const ca = cookieOf((await fresh.porthole.handle(get(a.url))) as Response);
    for (let i = 0; i < 3; i += 1) {
      await fresh.porthole.handle(get(a.url.replace(/\?ticket=.*/u, ""), { cookie: ca }));
    }
    expect(fresh.seen).toHaveLength(4);

    const cached = revocable(30);
    const b = await cached.porthole.issue(artifact, { viewer: "v", subject: "s" });
    const cb = cookieOf((await cached.porthole.handle(get(b.url))) as Response);
    const again = () =>
      cached.porthole.handle(get(b.url.replace(/\?ticket=.*/u, ""), { cookie: cb }));
    await again();
    await again();
    // The ticket's load and the cookie's reloads carry the same claims: one answer serves them.
    expect(cached.seen).toHaveLength(1);
    cached.revoked.add("s");
    expect((await again())?.status).toBe(200);
    vi.setSystemTime(1_000_000 + 31_000);
    expect((await again())?.status).toBe(403);
    expect(cached.seen).toHaveLength(2);

    for (const ttlSeconds of [-1, 1.5, 301]) {
      expect(() => server({ authorize: { check: () => ({ allow: true }), ttlSeconds } })).toThrow(
        /ttlSeconds/u,
      );
    }
  });
});

describe("the D1 ticket store (P045)", () => {
  /** node:sqlite in D1's shape: the same SQL D1 runs, on SQLite. */
  function sqliteD1(): D1Like {
    const db = new DatabaseSync(":memory:");
    for (const statement of d1TicketSchema()
      .split(";")
      .map((each) => each.trim())
      .filter(Boolean)) {
      db.exec(statement);
    }
    return {
      prepare(query) {
        let values: unknown[] = [];
        const statement: D1StatementLike = {
          bind(...given) {
            values = given;
            return statement;
          },
          run() {
            return Promise.resolve(db.prepare(query).run(...(values as never[])));
          },
          first<T>() {
            return Promise.resolve(
              (db.prepare(query).get(...(values as never[])) ?? null) as T | null,
            );
          },
        };
        return statement;
      },
    };
  }
  const record = (expiresAt: number): TicketRecord => ({
    instance: shell,
    viewer: "v",
    expiresAt,
    subject: "s",
  });

  it("gives a ticket once, and nothing once it's expired; sweeps expired ones as new ones go in", async () => {
    let now = 1_000;
    const db = sqliteD1();
    const store = d1TicketStore(db, { now: () => now });
    await store.put("a", record(2_000));
    await store.put("b", record(1_500));
    expect(await store.take("a")).toEqual(record(2_000));
    expect(await store.take("a")).toBeNull();
    now = 1_600;
    expect(await store.take("b")).toBeNull();
    await store.put("c", record(1_550));
    await store.put("d", record(9_000));
    const left = await db
      .prepare("SELECT count(*) AS n FROM porthole_tickets")
      .first<{ n: number }>();
    expect(left?.n).toBe(1);
  });

  it("serves a server as its ticket store", async () => {
    const porthole = server({ tickets: d1TicketStore(sqliteD1()) });
    const location = await porthole.issue(shell, { viewer: "v" });
    expect((await porthole.handle(get(location.url)))?.status).toBe(200);
    expect((await porthole.handle(get(location.url)))?.status).toBe(401);
  });

  it("names its table with a-z 0-9 _ only", () => {
    expect(() => d1TicketSchema("t; DROP TABLE x")).toThrow(/table/u);
    expect(() => d1TicketStore(sqliteD1(), { table: "a-b" })).toThrow(/table/u);
    expect(d1TicketSchema("tickets")).toContain("CREATE TABLE IF NOT EXISTS tickets (");
  });
});

describe("0.1.4: routing a host can rely on", () => {
  it("reserves label prefixes and a host's own predicate, for the host's routes", async () => {
    const byPrefix = server({
      content: {
        domain: DOMAIN,
        scheme: "https",
        name: prefixedName("a-"),
        reserved: ["p-*", "w-*", "www"],
      },
    });
    for (const url of [
      `https://p-123.${DOMAIN}/`,
      `https://w-x.${DOMAIN}/a`,
      `https://x.p-1.${DOMAIN}/`,
    ]) {
      expect(await byPrefix.handle(get(url)), url).toBeNull();
    }
    expect((await byPrefix.handle(get(`https://a-1.${DOMAIN}/x`)))?.status).toBe(404);
    expect(() =>
      server({
        content: { domain: DOMAIN, scheme: "https", name: () => "p-1", reserved: ["p-*"] },
      }).originFor("x"),
    ).toThrow(/reserved/u);
    for (const bad of ["P-*", "*", "p-**", "a.b*"]) {
      expect(
        () => server({ content: { domain: DOMAIN, scheme: "https", reserved: [bad] } }),
        bad,
      ).toThrow(/reserved/u);
    }
    const byFunction = server({
      content: {
        domain: DOMAIN,
        scheme: "https",
        name: prefixedName("a-"),
        reserved: (label) => {
          if (label === "boom") {
            throw new Error("broken");
          }
          return label.endsWith("-preview");
        },
      },
    });
    expect(await byFunction.handle(get(`https://x-preview.${DOMAIN}/`))).toBeNull();
    // A predicate that throws reserves the label: it goes to the host, never served as ours.
    expect(await byFunction.handle(get(`https://boom.${DOMAIN}/`))).toBeNull();
    expect((await byFunction.handle(get(`https://a-1.${DOMAIN}/`)))?.status).toBe(404);
  });

  it("refuses a request whose Host header names another host than its URL", async () => {
    const porthole = server();
    const location = await porthole.issue(shell, { viewer: "v" });
    const elsewhere = `https://${porthole.originFor("someone-else").slice("https://".length)}`;
    const crafted = (await porthole.handle(
      get(location.url, { host: new URL(elsewhere).host }),
    )) as Response;
    expect(crafted.status).toBe(400);
    expect(crafted.headers.get("content-security-policy")).toContain(`frame-ancestors ${HOST}`);
    // Absolute-form for another host, routed here by a Host of ours.
    expect(
      (
        await porthole.handle(
          get("https://other.example/x", { host: new URL(location.origin).host }),
        )
      )?.status,
    ).toBe(400);
    expect(await porthole.access(get(location.url, { host: "app.example.com" }))).toBeNull();
    // Agreeing (case, default port), or a local address as a test runner sends: served.
    const agreeing = (await porthole.handle(
      get(location.url, { host: `${new URL(location.origin).host.toUpperCase()}:443` }),
    )) as Response;
    expect(agreeing.status).toBe(200);
    const again = await porthole.issue(shell, { viewer: "v" });
    expect((await porthole.handle(get(again.url, { host: "127.0.0.1:8787" })))?.status).toBe(200);
    // Neither under the content domain: not ours at all.
    expect(
      await porthole.handle(get("https://app.example.com/", { host: "api.example.com" })),
    ).toBeNull();
  });

  it("tells search engines to keep out of content origins", async () => {
    const porthole = server();
    const location = await porthole.issue(shell, { viewer: "v" });
    for (const response of [
      (await porthole.handle(get(location.url))) as Response,
      (await porthole.handle(get(`${location.origin}/nothing`))) as Response,
    ]) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it("answers a path that isn't Porthole's with a plain 404 when it serves no apps", async () => {
    const porthole = server();
    const location = await porthole.issue(shell, { viewer: "v" });
    for (const path of ["/", "/favicon.ico", "/api/anything"]) {
      const response = (await porthole.handle(get(`${location.origin}${path}`))) as Response;
      expect(response.status, path).toBe(404);
      expect(await response.text()).toContain('data-porthole-reason="not-found"');
    }
  });
});
