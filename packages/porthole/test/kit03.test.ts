import { get as httpGet } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  defineDisplays,
  entryTarget,
  frameFallback,
  portholeClient,
  type InstanceRef,
} from "../src/index.ts";
import { nodeServer } from "../src/node/index.ts";
import {
  contentHostFor,
  createContentHost,
  prefixedName,
  statusPage,
  upstreamHeaders,
  withoutPortholeCookies,
  type ContentHostEvent,
  type ContentHostOptions,
} from "../src/server/index.ts";

/** The host kit's 0.3 additions (P072): displays, routes, the client, handoff, the relay kit. */

const APP = "https://app.example.com";
const SECRET = "a test secret that is at least thirty-two bytes long";
const SOURCE = "https://*.usercontent.example.net";
const origin = (scope: string) => `https://a-${scope}.usercontent.example.net`;

const displays = defineDisplays({
  widget: { preset: "inlineWidget", served: { storage: { shared: "conversation" } } },
  artifact: { preset: "artifact", options: { layout: { kind: "fill" } } },
  preview: { preset: "url" },
});

const page = (scope: string, version = "1"): InstanceRef => ({
  scope,
  document: { kind: "artifact", id: scope, version },
});

interface Viewer {
  readonly id: string;
}

function kit(extra: Partial<ContentHostOptions<Viewer>> = {}) {
  const content = createContentHost<Viewer>({
    domain: "usercontent.example.net",
    appOrigins: [APP],
    secret: SECRET,
    displays,
    name: prefixedName("a-"),
    instance: (proposal) =>
      proposal.document.kind === "artifact" ? page(proposal.document.id) : null,
    access: (instance, viewer) =>
      instance.scope.startsWith("secret") || viewer === null ? null : { viewer: viewer.id },
    source: (id, version) => Promise.resolve({ html: `<h1>${id} v${version}</h1>` }),
    entry: {
      at: (scope, path) => (path === "/" ? page(scope) : null),
      pathOf: () => "/",
      spa: { route: "/sign-in" },
      handoff: { id: (viewer) => viewer.id, viewer: (id) => ({ id }) },
    },
    ...extra,
  });
  const viewerOf = (request: Request) => {
    const who = /Bearer (\w+)/u.exec(request.headers.get("authorization") ?? "")?.[1];
    return who === undefined ? null : { id: who };
  };
  return { content, routes: content.routes(viewerOf) };
}

describe("defineDisplays", () => {
  it("gives each kind's opaque and served config, once each", () => {
    expect(displays.opaque("widget").isolation).toBe("opaque");
    const served = displays.served(SOURCE);
    expect(served?.widget).toMatchObject({
      isolation: "domain",
      storage: { shared: "conversation" },
    });
    expect(served?.preview.mode).toBe("url");
    expect(displays.served(SOURCE)).toBe(served);
    expect(() => displays.opaque("preview")).toThrow(/served only/u);
    expect(displays.configFor(page("x"), SOURCE)).toBe(served?.artifact);
    expect(displays.configFor(page("x"), null).isolation).toBe("opaque");
    expect(displays.kindOf({ scope: "x", document: { kind: "external", url: "http://a/" } })).toBe(
      "preview",
    );
  });

  it("gives the page's frame sources without a ContentHost, the authorize route included", () => {
    expect(
      displays.frameSources(SOURCE, { authorizeUrl: `${APP}/porthole/authorize?x=1` }),
    ).toContain(`${APP}/porthole/authorize`);
    expect(displays.embedderCsp(SOURCE)).toMatch(
      /^frame-src .*https:\/\/\*\.usercontent\.example\.net/u,
    );
    expect(displays.served("not a source")).toBeNull();
    expect(displays.problem("not a source")).toEqual(expect.any(String));
  });

  it("gives a served kind's config for the manual without a real origin", () => {
    expect(displays.guideConfig("widget", "served").isolation).toBe("domain");
  });
});

describe("content.routes", () => {
  it("answers frames, meta, authorize and handoff under /porthole, and nothing else", async () => {
    const { routes } = kit();
    const frames = await routes(
      new Request(`${APP}/porthole/frames`, {
        method: "POST",
        headers: { authorization: "Bearer ada", "content-type": "application/json" },
        body: JSON.stringify({ instance: page("abc") }),
      }),
    );
    expect(frames?.status).toBe(201);
    expect(await frames?.json()).toMatchObject({
      origin: origin("abc"),
      link: `${origin("abc")}/`,
    });
    const meta = await (await routes(new Request(`${APP}/porthole/meta`)))?.json();
    expect(meta).toMatchObject({ served: true, contentSource: SOURCE, health: null });
    expect((meta as { frameSources: string[] }).frameSources).toContain(
      `${APP}/porthole/authorize`,
    );
    expect(await routes(new Request(`${APP}/api/other`))).toBeNull();
    expect(await routes(new Request(`${APP}/porthole/nothing`))).toBeNull();
  });

  it("takes a clean path the app looks up (a promise), and issues without a link where it fails (P074)", async () => {
    const issue = async (pathOf: NonNullable<ContentHostOptions<Viewer>["entry"]>["pathOf"]) => {
      const { routes } = kit({
        entry: { at: (scope) => page(scope), ...(pathOf === undefined ? {} : { pathOf }) },
      });
      const frames = await routes(
        new Request(`${APP}/porthole/frames`, {
          method: "POST",
          headers: { authorization: "Bearer ada", "content-type": "application/json" },
          body: JSON.stringify({ instance: page("abc", "3") }),
        }),
      );
      expect(frames?.status).toBe(201);
      return (await frames?.json()) as { url: string; link?: string };
    };
    const looked = await issue(async (instance, request) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(request.method).toBe("POST");
      return `/v/${instance.document.kind === "artifact" ? instance.document.version : ""}`;
    });
    expect(looked.link).toBe(`${origin("abc")}/v/1`);
    const failed = await issue(() => Promise.reject(new Error("the database is down")));
    expect(failed.url).toContain(origin("abc"));
    expect(failed.link).toBeUndefined();
  });

  it("answers meta with served false when there is no content domain, so pages fall back (P074)", async () => {
    // Self-hosted with no domain for content: a host all the same, with no secret needed.
    const content = createContentHost<Viewer>({
      domain: null,
      appOrigins: [APP],
      secret: undefined as unknown as string,
      displays,
      instance: () => null,
      access: () => null,
    });
    const routes = content.routes(() => ({ id: "ada" }));
    const meta = await routes(new Request(`${APP}/porthole/meta`));
    expect(meta?.status).toBe(200);
    expect(await meta?.json()).toMatchObject({ served: false, contentSource: null });
    const client = portholeClient({
      displays,
      base: `${APP}/porthole`,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        (await routes(new Request(input, init))) ?? new Response(null, { status: 404 }),
    });
    await client.refresh();
    expect(client.config("artifact")?.isolation, "opaque, never pending").toBe("opaque");
    expect(await content.fetch(new Request(`${origin("abc")}/`))).toBeNull();
  });

  it("defaults the authorize route under the prefix; the prefix moves", async () => {
    const { content } = kit({ prefix: "/content" });
    const begin = await content.fetch(
      new Request(`${origin("abc")}/`, { headers: { "sec-fetch-dest": "document" } }),
    );
    expect(begin?.headers.get("location")).toMatch(
      /^https:\/\/app\.example\.com\/content\/authorize\?state=/u,
    );
  });

  it("signs a single-page app's viewer in through its route, with next", async () => {
    const { content, routes } = kit();
    const begin = await content.fetch(
      new Request(`${origin("abc")}/`, { headers: { "sec-fetch-dest": "document" } }),
    );
    const authorize = begin?.headers.get("location") ?? "";
    const signIn = await routes(
      new Request(authorize, { headers: { "sec-fetch-dest": "document" } }),
    );
    expect(signIn?.status).toBe(303);
    const to = new URL(signIn?.headers.get("location") ?? "");
    expect(`${to.origin}${to.pathname}`).toBe(`${APP}/sign-in`);
    expect(entryTarget(to.searchParams.get("next"), `${APP}/porthole/authorize`)).toBe(authorize);
    expect(
      entryTarget("https://evil.example/porthole/authorize?state=x", `${APP}/porthole/authorize`),
    ).toBeNull();
    expect(entryTarget(`${APP}/porthole/frames?state=x`, `${APP}/porthole/authorize`)).toBeNull();
  });

  it("entryTarget with { app: true } also takes the app's own pages, never another site (P074)", () => {
    const route = `${APP}/porthole/authorize`;
    const app = (next: unknown) => entryTarget(next, route, { app: true });
    expect(entryTarget("/settings", route), "only the authorize route by default").toBeNull();
    expect(app("/")).toBe(`${APP}/`);
    expect(app("/pages/1?tab=a#top")).toBe(`${APP}/pages/1?tab=a#top`);
    expect(app(`${APP}/pages/1`)).toBe(`${APP}/pages/1`);
    expect(app(`${route}?state=s`)).toBe(`${route}?state=s`);
    for (const elsewhere of [
      "//evil.example/x",
      "/\\evil.example/x",
      "/\t/evil.example/x",
      "\\\\evil.example",
      "https://evil.example/x",
      "https://app.example.com.evil.example/x",
      "http://app.example.com/x",
      "javascript:alert(1)",
      "data:text/html,x",
      "pages/1",
      "",
      null,
      42,
    ]) {
      expect(app(elsewhere), String(elsewhere)).toBeNull();
    }
  });
});

describe("behind a proxy (P074)", () => {
  it("sends the person back to the app's own authorize URL, not the URL the request arrived at", async () => {
    const signIns: string[] = [];
    const { content, routes } = kit({
      entry: {
        at: (scope, path) => (path === "/" ? page(scope) : null),
        signIn: (returnTo) => {
          signIns.push(returnTo);
          return new Response(null, { status: 303, headers: { location: `${APP}/login` } });
        },
      },
    });
    const begin = await content.fetch(
      new Request(`${origin("abc")}/`, { headers: { "sec-fetch-dest": "document" } }),
    );
    const state = new URL(begin?.headers.get("location") ?? "").search;
    // A TLS edge (the app sees http) and a dev proxy that rewrote Host.
    await routes(
      new Request(`http://localhost:5173/porthole/authorize${state}`, {
        headers: { host: "localhost:5173", "sec-fetch-dest": "document" },
      }),
    );
    expect(signIns).toEqual([`${APP}/porthole/authorize${state}`]);
    expect(entryTarget(signIns[0], `${APP}/porthole/authorize`)).toBe(signIns[0]);
  });

  it("builds a single-page app's next the same way", async () => {
    const { content, routes } = kit();
    const begin = await content.fetch(
      new Request(`${origin("abc")}/`, { headers: { "sec-fetch-dest": "document" } }),
    );
    const state = new URL(begin?.headers.get("location") ?? "").search;
    const signIn = await routes(
      new Request(`http://10.0.0.7:8080/porthole/authorize${state}`, {
        headers: { "sec-fetch-dest": "document" },
      }),
    );
    const to = new URL(signIn?.headers.get("location") ?? "");
    expect(`${to.origin}${to.pathname}`).toBe(`${APP}/sign-in`);
    expect(to.searchParams.get("next")).toBe(`${APP}/porthole/authorize${state}`);
  });
});

describe("the viewer handoff", () => {
  const post = (headers: Record<string, string>) =>
    new Request(`${APP}/porthole/handoff`, { method: "POST", headers });

  it("needs the app's own credential, from the app's own page", async () => {
    const { routes } = kit();
    expect((await routes(post({ origin: APP })))?.status).toBe(401);
    expect(
      (await routes(post({ origin: "https://evil.example", authorization: "Bearer ada" })))?.status,
    ).toBe(403);
    expect(
      (await routes(post({ "sec-fetch-site": "cross-site", authorization: "Bearer ada" })))?.status,
    ).toBe(403);
    const done = await routes(post({ origin: APP, authorization: "Bearer ada" }));
    expect(done?.status).toBe(204);
    const cookie = done?.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(
      /^__Secure-porthole-handoff=[\w-]+\.[\w-]+; Path=\/porthole; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/u,
    );
    expect(cookie).not.toContain("ada");
  });

  it("lets the authorize route know the viewer for 10 minutes, and no longer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { content, routes } = kit();
      const handed = await routes(post({ origin: APP, authorization: "Bearer ada" }));
      const cookie = (handed?.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const begin = await content.fetch(
        new Request(`${origin("abc")}/`, { headers: { "sec-fetch-dest": "document" } }),
      );
      const authorize = begin?.headers.get("location") ?? "";
      const known = await routes(
        new Request(authorize, { headers: { cookie, "sec-fetch-dest": "document" } }),
      );
      expect(known?.headers.get("location")).toContain("/__porthole/entry?code=");
      const forged = await routes(
        new Request(authorize, {
          headers: { cookie: `${cookie.slice(0, -3)}AAA`, "sec-fetch-dest": "document" },
        }),
      );
      expect(forged?.headers.get("location")).toContain("/sign-in?next=");
      vi.advanceTimersByTime(11 * 60_000);
      const again = await content.fetch(
        new Request(`${origin("abc")}/`, { headers: { "sec-fetch-dest": "document" } }),
      );
      const late = await routes(
        new Request(again?.headers.get("location") ?? "", {
          headers: { cookie, "sec-fetch-dest": "document" },
        }),
      );
      expect(late?.headers.get("location")).toContain("/sign-in?next=");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is cleared by DELETE", async () => {
    const { routes } = kit();
    const cleared = await routes(
      new Request(`${APP}/porthole/handoff`, { method: "DELETE", headers: { origin: APP } }),
    );
    expect(cleared?.headers.get("set-cookie")).toMatch(/^__Secure-porthole-handoff=; .*Max-Age=0/u);
  });
});

describe("server niceties", () => {
  it("tells served flips once each, and logs through a logger at each level", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let up = false;
      const flips: boolean[] = [];
      const said: string[] = [];
      const holder: { content: ReturnType<typeof createContentHost<Viewer>> | null } = {
        content: null,
      };
      const { content } = kit({
        health: {
          probe: async (url) => {
            if (!up || holder.content === null) {
              throw new Error("down");
            }
            const answer = (await holder.content.fetch(new Request(url))) as Response;
            return { status: answer.status, body: await answer.text() };
          },
          onServedChange: (served) => flips.push(served),
        },
        log: {
          info: (message: string, event: ContentHostEvent) =>
            said.push(`info ${event.evt} ${message.slice(0, 9)}`),
          warn: (message: string, event: ContentHostEvent) => said.push(`warn ${event.evt}`),
        },
      });
      holder.content = content;
      await content.check();
      await content.check();
      up = true;
      await content.check();
      expect(flips).toEqual([false, true]);
      expect(said).toEqual([
        "warn porthole.content.unhealthy",
        "info porthole.content.healthy Porthole:",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets cached authorize answers when asked", async () => {
    let allowed = true;
    let asked = 0;
    const { content, routes } = kit({
      authorize: () => {
        asked += 1;
        return allowed ? { allow: true } : { allow: false, code: "revoked" };
      },
      authorizeTtlSeconds: 60,
    });
    const frames = await routes(
      new Request(`${APP}/porthole/frames`, {
        method: "POST",
        headers: { authorization: "Bearer ada", "content-type": "application/json" },
        body: JSON.stringify({ instance: page("abc") }),
      }),
    );
    const location = (await frames?.json()) as { url: string };
    const first = await content.fetch(
      new Request(location.url, { headers: { "sec-fetch-dest": "iframe" } }),
    );
    const cookie = (first?.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const again = () =>
      content.fetch(
        new Request(location.url.replace(/\?.*$/u, ""), {
          headers: { cookie, "sec-fetch-dest": "iframe" },
        }),
      );
    expect((await again())?.status).toBe(200);
    allowed = false;
    expect((await again())?.status, "cached for its ttl").toBe(200);
    const before = asked;
    content.forget({ scope: "abc" });
    expect((await again())?.status).toBe(403);
    expect(asked, "asked again once forgotten").toBe(before + 1);
  });

  it("contentHostFor: one host per settings object, and a plain 503 naming why when they can't be served", async () => {
    const porthole = contentHostFor((env: { readonly domain: string }) => ({
      domain: env.domain,
      appOrigins: [APP],
      secret: SECRET,
      displays,
      instance: () => null,
      access: () => null,
    }));
    const good = { domain: "usercontent.example.net" };
    expect(porthole.host(good)).toBe(porthole.host(good));
    expect(await porthole.fetch(new Request(`${APP}/`), good)).toBeNull();
    const bad = { domain: "app.example.com" };
    const refused = await porthole.fetch(new Request(`${APP}/`), bad);
    expect(refused?.status).toBe(503);
    expect(await refused?.text()).toMatch(
      /content domain can't be served: .*holds the app's own origin/u,
    );
    // A Worker without its secret (no .dev.vars, no `wrangler secret put`): named, not a crash.
    const unset = contentHostFor((env: { readonly PORTHOLE_SECRET?: string }) => ({
      domain: "usercontent.example.net",
      appOrigins: [APP],
      secret: env.PORTHOLE_SECRET as string,
      displays,
      instance: () => null,
      access: () => null,
    }));
    const missing = await unset.fetch(new Request(`${APP}/`), {});
    expect(missing?.status).toBe(503);
    expect(await missing?.text()).toMatch(/needs a secret.*PORTHOLE_SECRET/u);
  });

  it("names a missing secret, and a short one, with where to get one (P074)", () => {
    const options = (secret: unknown, extra: Partial<ContentHostOptions<Viewer>> = {}) =>
      ({
        domain: "usercontent.example.net",
        appOrigins: [APP],
        secret,
        displays,
        instance: () => null,
        access: () => null,
        ...extra,
      }) as ContentHostOptions<Viewer>;
    for (const secret of [undefined, null, 42]) {
      expect(() => createContentHost(options(secret)), String(secret)).toThrow(
        /createContentHost needs a secret: at least 32 random bytes \(set PORTHOLE_SECRET; npx porthole secret makes one\)/u,
      );
    }
    for (const secret of ["", "short", "   "]) {
      expect(() => createContentHost(options(secret)), secret).toThrow(
        /The secret must be at least 32 random bytes \(set PORTHOLE_SECRET/u,
      );
    }
    // Under the health gate's fallback, a lasting "misconfigured" saying the same (P066).
    const gated = createContentHost(
      options(undefined, { health: { probe: () => Promise.reject(new Error("unused")) } }),
    );
    expect(gated.meta().health).toMatchObject({ state: "unhealthy", misconfigured: true });
    expect(gated.meta().health?.reason).toMatch(/needs a secret.*PORTHOLE_SECRET/u);
    // Content off ("") needs no secret.
    expect(createContentHost(options(undefined, { domain: "" })).meta().served).toBe(false);
  });
});

describe("the client", () => {
  it("knows each kind's config from meta, locates with links, and refreshes when not served", async () => {
    const { routes } = kit();
    const client = portholeClient({
      displays,
      base: `${APP}/porthole`,
      headers: { authorization: "Bearer ada" },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        (await routes(new Request(input, init))) ?? new Response(null, { status: 404 }),
    });
    expect(client.config("widget")).toBeNull();
    await client.refresh();
    expect(client.config("widget")?.isolation).toBe("domain");
    expect(client.config("preview")?.mode).toBe("url");
    const location = await client.locate(page("abc"));
    expect(location.origin).toBe(origin("abc"));
    expect(client.knownLink(page("abc"))).toBe(`${origin("abc")}/`);
    expect(await client.link(page("xyz"))).toBe(`${origin("xyz")}/`);
    expect(client.entryTarget(`${APP}/porthole/authorize?state=s`)).toBe(
      `${APP}/porthole/authorize?state=s`,
    );
    // Outside a browser there is no Origin to judge: the app's credential is what counts.
    expect(await client.handoff()).toBe(true);
  });

  it("hands out its functions bare, as React's useSyncExternalStore takes them (P074)", async () => {
    const { routes } = kit();
    // Each taken off the client, as `useSyncExternalStore(porthole.subscribe, porthole.meta)`
    // takes them: typed `this: void`, so type-aware lint's unbound-method has nothing to say.
    const {
      subscribe,
      meta,
      refresh,
      config,
      configFor,
      locate,
      link,
      knownLink,
      entryTarget: target,
      close,
    } = portholeClient({
      displays,
      base: `${APP}/porthole`,
      headers: { authorization: "Bearer ada" },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        (await routes(new Request(input, init))) ?? new Response(null, { status: 404 }),
    });
    let told = 0;
    const stop = subscribe(() => {
      told += 1;
    });
    expect(meta()).toBeNull();
    await refresh();
    expect(told).toBe(1);
    expect(meta()?.served).toBe(true);
    expect(config("artifact")?.isolation).toBe("domain");
    expect(configFor(page("abc"))?.isolation).toBe("domain");
    expect((await locate(page("abc"))).origin).toBe(origin("abc"));
    expect(knownLink(page("abc"))).toBe(`${origin("abc")}/`);
    expect(await link(page("xyz"))).toBe(`${origin("xyz")}/`);
    expect(target("/pages", { app: true })).toBe(`${APP}/pages`);
    stop();
    close();
  });

  it("falls back to opaque configs (and none for a url kind) while frames aren't served", () => {
    const client = portholeClient({
      displays,
      meta: {
        served: false,
        contentSource: null,
        frameSources: [],
        health: { state: "unhealthy" },
      },
      fetch: () => Promise.reject(new Error("offline")),
    });
    expect(client.config("widget")?.isolation).toBe("opaque");
    expect(client.config("preview")).toBeNull();
  });

  it("words a frame's outcome as the fallback to offer", () => {
    expect(frameFallback({ state: "loaded" })).toBeNull();
    expect(frameFallback({ state: "blocked", reason: "cookies" })?.kind).toBe("needs-tab");
    expect(frameFallback({ state: "blocked", reason: "sign-in" })?.title).toBe(
      "Open this in a new tab to sign in",
    );
    expect(frameFallback({ state: "blocked", reason: "denied" })?.kind).toBe("denied");
    expect(frameFallback({ state: "blocked", reason: "session" })?.kind).toBe("expired");
    expect(frameFallback({ state: "timeout" }, { url: true })?.kind).toBe("needs-tab");
    expect(frameFallback({ state: "timeout" })?.kind).toBe("timeout");
  });
});

describe("the url-mode relay kit", () => {
  it("rewrites a relayed request's and answer's headers as proxyTo does, Porthole's cookies kept out", () => {
    const request = upstreamHeaders.request(
      {
        host: "p-1.usercontent.example.net",
        origin: "https://p-1.usercontent.example.net",
        cookie: "app=1; __Host-porthole-abc=secret; porthole-n-x=1",
        "x-forwarded-for": "1.2.3.4",
        upgrade: "websocket",
        connection: "Upgrade",
      },
      {
        origin: "https://p-1.usercontent.example.net",
        target: "http://127.0.0.1:5173",
        websocket: true,
      },
    );
    expect(Object.fromEntries(request)).toMatchObject({
      origin: "http://127.0.0.1:5173",
      cookie: "app=1",
      upgrade: "websocket",
      host: "127.0.0.1:5173",
    });
    expect(Object.fromEntries(request)["x-forwarded-for"]).toBeUndefined();
    const answer = upstreamHeaders.response(
      [
        ["location", "http://127.0.0.1:5173/next"],
        ["set-cookie", "app=2; Domain=127.0.0.1"],
        ["set-cookie", "porthole-x=evil"],
      ],
      { origin: "https://p-1.usercontent.example.net", target: "http://127.0.0.1:5173" },
    );
    expect(answer).toContainEqual(["location", "https://p-1.usercontent.example.net/next"]);
    expect(answer.filter(([name]) => name === "set-cookie")).toEqual([["set-cookie", "app=2"]]);
    expect(withoutPortholeCookies("porthole-a=1; __Secure-porthole-handoff=2")).toBeNull();
  });

  it("gives the status page, its script under its hash, with the desktop fallback", async () => {
    const shown = statusPage({
      status: 401,
      title: "Open this in a new tab",
      detail: "No cookie in a frame.",
      reason: "cookies",
      hostOrigins: [APP, "ferry://app"],
    });
    expect(shown.headers.get("content-security-policy")).toMatch(/script-src 'sha256-/u);
    expect(await shown.text()).toContain('"*"');
  });
});

describe("nodeServer", () => {
  it("takes a host made after it listens: the app's until then, then the content domain's", async () => {
    let made: ReturnType<typeof kit>["content"] | null = null;
    const server = nodeServer({ content: () => made, app: () => new Response("the app") });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const ask = (host: string) =>
      new Promise<number>((resolve, reject) => {
        httpGet({ host: "127.0.0.1", port, path: "/", headers: { host } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }).on("error", reject);
      });
    try {
      expect(await ask(`www.usercontent.localhost:${port}`)).toBe(200);
      // The content domain names the port it got.
      made = kit({
        domain: `usercontent.localhost:${port}`,
        appOrigins: ["http://localhost:1"],
      }).content;
      expect(await ask(`www.usercontent.localhost:${port}`)).toBe(404);
      expect(await ask(`localhost:${port}`)).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("serves content and the app on one server, the gate started on listen", async () => {
    const { content } = kit({
      domain: "usercontent.localhost",
      appOrigins: ["http://localhost:1"],
    });
    const server = nodeServer({ content, app: () => new Response("the app") });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("the app");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
