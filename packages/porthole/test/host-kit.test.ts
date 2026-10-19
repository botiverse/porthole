import { spawn } from "node:child_process";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type RequestListener,
} from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpLocator, LocateError, presets, servedOrOpaque } from "../src/index.ts";
import type { InstanceRef } from "../src/isolation/types.ts";
import { nodeHost, nodeListener, nodeProbe, sendResponse } from "../src/node/index.ts";
import {
  ContentDomainError,
  contentDomain,
  createContentHost,
  HEALTH_PATH,
  prefixedName,
  type ContentHostEvent,
  type ContentHostOptions,
} from "../src/server/index.ts";
import { ISSUE_BODY_BYTES } from "../src/server/host.ts";

/** The host kit (P066): domain settings, the routing middleware, the issue endpoint, the gate. */

const APP = "https://app.example.com";
const SECRET = "a test secret that is at least thirty-two bytes long";

interface Viewer {
  readonly id: string;
}

const page = (scope: string): InstanceRef => ({
  scope,
  document: { kind: "artifact", id: scope, version: "1" },
});

/** An app's whole policy, as an adopter writes it. */
function kit(extra: Partial<ContentHostOptions<Viewer>> = {}) {
  const events: ContentHostEvent[] = [];
  const revoked = new Set<string>();
  const content = createContentHost<Viewer>({
    domain: "usercontent.example.net",
    appOrigins: [APP],
    secret: SECRET,
    configs: (source) => ({
      artifact: presets.artifact({ isolation: "domain", contentOrigins: [source] }),
    }),
    name: prefixedName("a-"),
    reserved: ["p-*"],
    // Mapping: the proposal names a page; the scope is derived from it, never taken.
    instance: (proposal) =>
      proposal.document.kind === "artifact" && /^[a-z0-9]{1,20}$/u.test(proposal.document.id)
        ? page(proposal.document.id)
        : null,
    // Access: signed-in viewers see every page; "public" pages anyone.
    access: (instance, viewer) =>
      viewer !== null
        ? { viewer: viewer.id, subject: viewer.id }
        : instance.scope.startsWith("public")
          ? { anonymous: true, subject: "public" }
          : null,
    authorize: ({ subject }) =>
      subject !== undefined && revoked.has(subject)
        ? { allow: false, code: "revoked" }
        : { allow: true },
    source: (id) =>
      Promise.resolve({ html: `<!doctype html><title>${id}</title><h1 id="t">${id}</h1>` }),
    log: (event) => events.push(event),
    ...extra,
  });
  const issue = content.issue((request) => {
    const who = request.headers.get("x-viewer");
    return who === null ? null : { id: who };
  });
  const ask = (instance: unknown, viewer?: string) =>
    issue(
      new Request(`${APP}/api/frames`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(viewer === undefined ? {} : { "x-viewer": viewer }),
        },
        body: JSON.stringify({ instance }),
      }),
    );
  return { content, events, revoked, ask };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("contentDomain", () => {
  it("parses host[:port] and origins, http only on loopback", () => {
    const prod = contentDomain("UserContent.Example.net", { appOrigins: [APP] });
    expect(prod).toMatchObject({
      domain: "usercontent.example.net",
      scheme: "https",
      source: "https://*.usercontent.example.net",
    });
    expect(prod?.originOf("a-1")).toBe("https://a-1.usercontent.example.net");
    expect(prod?.isContentHost("A-1.usercontent.example.net:443")).toBe(true);
    expect(prod?.isContentHost("usercontent.example.net.evil.com")).toBe(false);
    expect(prod?.labelOf("x.f.usercontent.example.net")).toBe("x.f");
    const dev = contentDomain("content.localhost:8790", { appOrigins: ["http://localhost:5173"] });
    expect(dev).toMatchObject({
      scheme: "http",
      port: 8790,
      source: "http://*.content.localhost:8790",
    });
    expect(
      contentDomain("https://content.example.net:443/", { appOrigins: [APP] })?.port,
    ).toBeUndefined();
    expect(contentDomain("", { appOrigins: [APP] })).toBeNull();
    expect(contentDomain(undefined, { appOrigins: [APP] })).toBeNull();
  });

  it("refuses what isn't a domain, http off loopback, and clashes with the app, each by name", () => {
    const code = (input: string, appOrigins: string[] = [APP]) => {
      try {
        contentDomain(input, { appOrigins });
        return "accepted";
      } catch (error) {
        expect(error).toBeInstanceOf(ContentDomainError);
        return (error as ContentDomainError).code;
      }
    };
    expect(code("not a domain")).toBe("invalid");
    expect(code("127.0.0.1:8080")).toBe("invalid");
    expect(code("http://content.example.net")).toBe("invalid");
    expect(code("content.example.net:99999")).toBe("invalid");
    expect(code("example.com", ["https://app.example.com"])).toBe("clash");
    expect(code("example.com", ["https://example.com"])).toBe("clash");
    expect(code("content.example.com", ["https://app.example.com"])).toBe("same-site");
    expect(code("usercontent.example.net", ["https://app.example.com", "ferry://app"])).toBe(
      "accepted",
    );
  });
});

describe("the routing middleware", () => {
  it("answers every request under the content domain, and hands back the app's own hosts and reserved labels", async () => {
    const { content } = kit();
    expect(await content.fetch(new Request(`${APP}/anything`))).toBeNull();
    expect(await content.fetch(new Request("https://p-1234.usercontent.example.net/"))).toBeNull();
    expect(content.owns(new Request("https://p-1234.usercontent.example.net/"))).toBe(false);
    expect(content.owns(new Request("https://a-1.usercontent.example.net/"))).toBe(true);
    for (const url of [
      "https://usercontent.example.net/",
      "https://a-1.usercontent.example.net/api/secret",
      "https://x.y.usercontent.example.net/",
    ]) {
      const response = (await content.fetch(new Request(url))) as Response;
      expect(response.status, url).toBe(404);
    }
    // Routed by Host where the URL is another's (an absolute-form target): Porthole's 400.
    const crafted = await content.fetch(
      new Request("https://other.example.org/x", {
        headers: { host: "a-1.usercontent.example.net" },
      }),
    );
    expect(crafted?.status).toBe(400);
  });

  it("is off with no content domain: nothing is the content domain's, and nothing is served", async () => {
    const { content, ask } = kit({ domain: "" });
    expect(await content.fetch(new Request("https://a-1.usercontent.example.net/"))).toBeNull();
    expect(content.meta()).toEqual({ served: false, contentSource: null, health: null });
    expect(content.frameSources).toEqual([]);
    const refused = await ask(page("abc"), "v1");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: "not-served" } });
  });
});

describe("the issue endpoint", () => {
  it("maps the proposal, checks access, and answers 201 with a location on the server's own origin", async () => {
    const { content, ask } = kit();
    const answer = await ask(
      { scope: "ignored", document: { kind: "artifact", id: "abc", version: "9" } },
      "v1",
    );
    expect(answer.status).toBe(201);
    const location = (await answer.json()) as { url: string; origin: string; reports: boolean };
    // The scope came from the app's mapping, not from the client.
    expect(location.origin).toBe("https://a-abc.usercontent.example.net");
    expect(location.reports).toBe(true);
    const served = (await content.fetch(
      new Request(location.url, { headers: { "sec-fetch-dest": "iframe" } }),
    )) as Response;
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("abc");
  });

  it("refuses: 405 not POST, 400 bad bodies, 404 unmapped, 401 no viewer, 403 no access, 409 refused", async () => {
    const { content, ask } = kit();
    const issue = content.issue(() => null);
    expect((await issue(new Request(`${APP}/api/frames`))).status).toBe(405);
    expect(
      (await issue(new Request(`${APP}/api/frames`, { method: "POST", body: "{" }))).status,
    ).toBe(400);
    expect((await ask({ scope: 1 }, "v1")).status).toBe(400);
    expect(
      (await ask({ scope: "x", document: { kind: "shell", preset: "inlineWidget" } }, "v1")).status,
    ).toBe(404);
    expect((await ask(page("private1"))).status).toBe(401);
    expect((await ask(page("public1"))).status).toBe(201);
    const forbidden = kit({ access: () => null });
    expect((await forbidden.ask(page("abc"), "v1")).status).toBe(403);
    const unconfigured = kit({ configs: {} });
    const refused = await unconfigured.ask(page("abc"), "v1");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "refused" } });
  });

  describe("reads at most ISSUE_BODY_BYTES of the body, whatever it declares (S06, P092)", () => {
    const LIMIT = ISSUE_BODY_BYTES;
    /** `{ instance }` padded with whitespace (still valid JSON) to `total` bytes, pulled lazily. */
    const padded = (instance: unknown, total: number, chunk = 16_384) => {
      const head = new TextEncoder().encode(JSON.stringify({ instance }));
      const seen = { pulled: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (seen.pulled >= total) {
              controller.close();
              return;
            }
            const size = Math.min(chunk, total - seen.pulled);
            const bytes = new Uint8Array(size).fill(0x20);
            bytes.set(head.subarray(seen.pulled, seen.pulled + size));
            seen.pulled += size;
            controller.enqueue(bytes);
          },
          cancel() {
            seen.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return { body, seen };
    };
    const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
      new Request(`${APP}/api/frames`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        duplex: "half",
      } as RequestInit);
    const anonymous = () => {
      const { content } = kit();
      const asked = { viewer: 0 };
      const issue = content.issue(() => {
        asked.viewer += 1;
        return null;
      });
      return { issue, asked };
    };

    it("a chunked body (no Content-Length) past the limit: 413, the read stopped and cancelled", async () => {
      const { issue } = anonymous();
      const { body, seen } = padded(page("public1"), 10 * 1_048_576);
      const answer = await issue(post(body));
      expect(answer.status).toBe(413);
      expect(await answer.json()).toMatchObject({ error: { code: "too-large" } });
      expect(seen.pulled).toBeLessThanOrEqual(LIMIT + 16_384);
      expect(seen.cancelled).toBe(true);
    });

    it("a Content-Length under the truth is no bound: the bytes read are counted", async () => {
      const { issue } = anonymous();
      const { body, seen } = padded(page("public1"), 1_048_576);
      const answer = await issue(post(body, { "content-length": "60" }));
      expect(answer.status).toBe(413);
      expect(seen.pulled).toBeLessThanOrEqual(LIMIT + 16_384);
      const junk = await issue(post("x".repeat(LIMIT + 1), { "content-length": "not a number" }));
      expect(junk.status).toBe(413);
    });

    it("a Content-Length over the limit is refused before anything is read or asked", async () => {
      const { issue, asked } = anonymous();
      const { body, seen } = padded(page("public1"), 1_024);
      const answer = await issue(post(body, { "content-length": String(LIMIT + 1) }));
      expect(answer.status).toBe(413);
      expect(seen.pulled).toBe(0);
      expect(asked.viewer).toBe(0);
    });

    it("anonymous public access still works: chunked, declared, and exactly at the limit", async () => {
      const { issue } = anonymous();
      expect((await issue(post(padded(page("public1"), 2_000, 7).body))).status).toBe(201);
      expect((await issue(post(JSON.stringify({ instance: page("public2") })))).status).toBe(201);
      expect((await issue(post(padded(page("public3"), LIMIT).body))).status).toBe(201);
      expect((await issue(post(padded(page("public4"), LIMIT + 1).body))).status).toBe(413);
      // Access is still the app's: a private page without a viewer is 401, at any size.
      expect((await issue(post(padded(page("private1"), 2_000).body))).status).toBe(401);
    });

    it("over Node, chunked: the client gets its 413, the server stops reading and closes", async () => {
      const { issue } = anonymous();
      const server = createHttpServer(nodeListener(issue));
      let read = 0;
      server.on("connection", (socket) => socket.on("close", () => (read = socket.bytesRead)));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        // A body read whole keeps its connection.
        const small = JSON.stringify({ instance: page("public1") });
        const kept = await new Promise<string | undefined>((resolve, reject) => {
          const asked = httpRequest(
            { host: "127.0.0.1", port, path: "/api/frames", method: "POST" },
            (response) => {
              response.resume();
              resolve(response.statusCode === 201 ? response.headers.connection : "not 201");
            },
          );
          asked.on("error", reject);
          asked.end(small);
        });
        expect(kept).toBe("keep-alive");
        const said = await new Promise<string>((resolve, reject) => {
          const asked = httpRequest(
            { host: "127.0.0.1", port, path: "/api/frames", method: "POST" },
            (response) => {
              resolve(`${response.statusCode} ${response.headers.connection}`);
              asked.destroy();
            },
          );
          asked.on("error", reject);
          const chunk = Buffer.alloc(65_536, 0x20);
          let sent = 0;
          const pump = () => {
            while (sent < 64 * 1_048_576 && !asked.destroyed) {
              sent += chunk.byteLength;
              if (!asked.write(chunk)) {
                asked.once("drain", pump);
                return;
              }
            }
          };
          asked.write(JSON.stringify({ instance: page("public1") }));
          pump();
        });
        expect(said).toBe("413 close");
        // Closed by the server once the answer is out, not parked on the unread body.
        await vi.waitFor(() => expect(read).toBeGreaterThan(0));
        // What the socket took off the wire: the limit and the buffers on the way, not the 64 MiB.
        expect(read).toBeLessThan(4 * 1_048_576);
      } finally {
        server.close();
      }
    });

    it("bad JSON, an empty body and a body that breaks off are 400", async () => {
      const { issue } = anonymous();
      expect((await issue(post("{"))).status).toBe(400);
      expect((await issue(post(null))).status).toBe(400);
      const broken = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("the client went away"));
        },
      });
      const answer = await issue(post(broken));
      expect(answer.status).toBe(400);
      expect(await answer.json()).toMatchObject({ error: { code: "bad-json" } });
    });
  });

  it("rate-limits per viewer when asked to", async () => {
    const { ask } = kit({ rateLimit: { perMinute: 2 } });
    expect((await ask(page("a1"), "v1")).status).toBe(201);
    expect((await ask(page("a2"), "v1")).status).toBe(201);
    expect((await ask(page("a3"), "v1")).status).toBe(429);
    expect((await ask(page("a3"), "v2")).status).toBe(201);
  });

  it("carries the per-request check: a revoked subject's cookie is denied on its next request", async () => {
    const { content, revoked, ask } = kit();
    const location = (await (await ask(page("abc"), "v9")).json()) as { url: string };
    const first = (await content.fetch(
      new Request(location.url, { headers: { "sec-fetch-dest": "iframe" } }),
    )) as Response;
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    revoked.add("v9");
    const again = (await content.fetch(
      new Request(location.url.replace(/\?ticket=.*/u, ""), {
        headers: { cookie, "sec-fetch-dest": "iframe" },
      }),
    )) as Response;
    expect(again.status).toBe(403);
  });
});

describe("misconfiguration: never served; thrown, or a lasting unhealthy under the fallback", () => {
  it("throws a typed error at startup without the fallback", () => {
    expect(() => kit({ domain: "example.com", appOrigins: ["https://app.example.com"] })).toThrow(
      ContentDomainError,
    );
    expect(() => kit({ secret: "short" })).toThrow(/32/u);
  });

  it("with the health gate, is unhealthy for good, told once, frames not served, never probed", async () => {
    const probe = vi.fn(() => Promise.resolve({ status: 200, body: "{}" }));
    const { content, events, ask } = kit({
      domain: "example.com",
      appOrigins: ["https://app.example.com"],
      health: { probe },
    });
    expect(content.meta()).toMatchObject({
      served: false,
      health: { state: "unhealthy", misconfigured: true },
    });
    expect(content.meta().health?.reason).toMatch(
      /^misconfigured: The content domain example\.com holds/u,
    );
    expect(events).toEqual([
      expect.objectContaining({ evt: "porthole.content.misconfigured", code: "clash" }),
    ]);
    content.start();
    await content.check();
    expect(probe).not.toHaveBeenCalled();
    expect((await ask(page("abc"), "v1")).status).toBe(503);
    // A content domain it can't serve is never the app's to answer for its own hosts.
    expect(await content.fetch(new Request("https://app.example.com/"))).toBeNull();
    const short = kit({ secret: "short", health: { probe } });
    expect(short.content.meta().health).toMatchObject({ state: "unhealthy", misconfigured: true });
    expect(
      await short.content.fetch(new Request("https://a-1.usercontent.example.net/")),
    ).toMatchObject({ status: 503 });
  });
});

describe("the health gate", () => {
  it("answers who it is on its label, keyed: another deployment's answer fails", async () => {
    const one = kit({ health: { probe: () => Promise.reject(new Error("unused")) } });
    const answer = (await one.content.fetch(
      new Request(`https://porthole-health.usercontent.example.net${HEALTH_PATH}`),
    )) as Response;
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { porthole: string; id: string };
    expect(body.porthole).toBe("content-domain");
    const other = kit({
      secret: `${SECRET} but another`,
      health: { probe: () => Promise.resolve({ status: 200, body: JSON.stringify(body) }) },
    });
    expect(await other.content.check()).toMatchObject({
      state: "unhealthy",
      reason: expect.stringContaining("another deployment"),
    });
  });

  it("serves while its own answer comes back; falls back to opaque while it doesn't; checks again later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let up = false;
    let hosted: ReturnType<typeof kit> | null = null;
    const probe = async (url: string) => {
      if (!up || hosted === null) {
        throw new Error("ECONNREFUSED connect");
      }
      const answer = (await hosted.content.fetch(new Request(url))) as Response;
      return { status: answer.status, body: await answer.text() };
    };
    const flips: string[] = [];
    hosted = kit({ health: { probe, onChange: (view) => flips.push(view.state) } });
    const { content, events, ask } = hosted;
    expect(content.meta()).toMatchObject({ served: false, health: { state: "checking" } });
    await content.check();
    expect(content.meta()).toMatchObject({ served: false, health: { state: "unhealthy" } });
    expect((await ask(page("abc"), "v1")).status).toBe(503);
    up = true;
    content.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(content.meta()).toMatchObject({ served: true, health: { state: "healthy" } });
    expect((await ask(page("abc"), "v1")).status).toBe(201);
    up = false;
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(content.meta().served, "healthy is checked every ten minutes").toBe(true);
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    expect(content.meta().served).toBe(false);
    expect(events.map((event) => event.evt)).toEqual([
      "porthole.content.unhealthy",
      "porthole.content.healthy",
      "porthole.content.unhealthy",
    ]);
    // onChange: each change of state, as meta().served follows it (P070).
    expect(flips).toEqual(["unhealthy", "healthy", "unhealthy"]);
    content.close();
  });
});

describe("the client", () => {
  it("httpLocator POSTs { instance }, and throws the endpoint's refusal with its code", async () => {
    const { ask } = kit();
    const seen: { body: string; headers: Headers }[] = [];
    let notServed = 0;
    const fetchVia = (async (_url: string, init: RequestInit) => {
      seen.push({ body: init.body as string, headers: new Headers(init.headers) });
      const viewer = new Headers(init.headers).get("authorization")?.replace("Bearer ", "");
      return ask(JSON.parse(init.body as string).instance, viewer || undefined);
    }) as unknown as typeof fetch;
    const locator = httpLocator("/api/frames", {
      headers: () => ({ authorization: "Bearer v1" }),
      fetch: fetchVia,
      onNotServed: () => (notServed += 1),
    });
    const location = await locator.locate(page("abc"));
    expect(location.origin).toBe("https://a-abc.usercontent.example.net");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ instance: page("abc") });
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    const anonymous = httpLocator("/api/frames", { fetch: fetchVia });
    await expect(anonymous.locate(page("private1"))).rejects.toMatchObject({
      status: 401,
      code: "unauthenticated",
    });
    const off = kit({ domain: "" });
    const offLocator = httpLocator("/x", {
      fetch: (async (_url: string, init: RequestInit) =>
        off.ask(JSON.parse(init.body as string).instance, "v1")) as unknown as typeof fetch,
      onNotServed: () => (notServed += 1),
    });
    await expect(offLocator.locate(page("abc"))).rejects.toBeInstanceOf(LocateError);
    expect(notServed).toBe(1);
  });

  it("servedOrOpaque waits for meta, then picks served configs or opaque ones", () => {
    const opaque = { page: presets.artifact() };
    const served = (source: string) => ({
      page: presets.artifact({ isolation: "domain", contentOrigins: [source] }),
    });
    expect(servedOrOpaque(undefined, served, opaque)).toBeNull();
    expect(
      servedOrOpaque({ served: false, contentSource: "https://*.c.example.net" }, served, opaque),
    ).toMatchObject({ served: false });
    const on = servedOrOpaque(
      { served: true, contentSource: "https://*.c.example.net" },
      served,
      opaque,
    );
    expect(on?.served).toBe(true);
    expect(on?.configs.page.isolation).toBe("domain");
  });
});

describe("on Node", () => {
  it("routes requests and WebSockets by Host: content to Porthole, the app's hosts and reserved labels to the app", async () => {
    const { content } = kit({ domain: "content.localhost", appOrigins: ["http://localhost:5173"] });
    const appSockets: string[] = [];
    const porthole = nodeHost(content, {
      request: (_request, response) =>
        response.writeHead(200, { "content-type": "text/plain" }).end("the app"),
      upgrade: (request, socket) => {
        appSockets.push(request.headers.host ?? "");
        socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n");
      },
    });
    const server = createHttpServer(porthole.request);
    server.on("upgrade", porthole.upgrade);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const get = (host: string, path = "/") =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const asked = httpRequest(
          { host: "127.0.0.1", port, path, headers: { host } },
          (response) => {
            let body = "";
            response.on("data", (chunk) => (body += String(chunk)));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        asked.on("error", reject);
        asked.end();
      });
    const upgrade = (host: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
          );
        });
        let said = "";
        socket.on("data", (chunk) => (said += String(chunk)));
        socket.on("end", () => resolve(said.split("\r\n")[0] ?? ""));
        socket.on("error", reject);
      });
    try {
      expect(await get(`localhost:${port}`)).toEqual({ status: 200, body: "the app" });
      expect(await get(`p-1.content.localhost:${port}`)).toEqual({ status: 200, body: "the app" });
      expect((await get(`a-1.content.localhost:${port}`, "/api")).status).toBe(404);
      expect(await upgrade(`p-1.content.localhost:${port}`)).toBe(
        "HTTP/1.1 101 Switching Protocols",
      );
      expect(await upgrade(`a-1.content.localhost:${port}`)).toBe("HTTP/1.1 404 Not Found");
      expect(await upgrade(`localhost:${port}`)).toBe("HTTP/1.1 101 Switching Protocols");
      expect(appSockets).toEqual([`p-1.content.localhost:${port}`, `localhost:${port}`]);
    } finally {
      server.close();
    }
  });

  it("the health gate's Node probe reaches the content domain on loopback, over the real network", async () => {
    let hosted: ReturnType<typeof kit> | null = null;
    const server = createHttpServer((request, response) => {
      if (hosted === null) {
        response.end();
        return;
      }
      nodeHost(hosted.content, { request: (_q, r) => r.end("app") }).request(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      hosted = kit({
        domain: `content.localhost:${port}`,
        appOrigins: ["http://localhost:5173"],
        health: { probe: nodeProbe() },
      });
      expect(await hosted.content.check()).toMatchObject({ state: "healthy" });
      expect(hosted.content.meta().served).toBe(true);
      server.close();
      const down = kit({
        domain: `content.localhost:${port}`,
        appOrigins: ["http://localhost:5173"],
        health: { probe: nodeProbe(), timeoutMs: 500 },
      });
      expect(await down.content.check()).toMatchObject({
        state: "unhealthy",
        reason: expect.stringMatching(/porthole-health\.content\.localhost: ECONN(REFUSED|RESET)/u),
      });
    } finally {
      server.close();
    }
  });
});

describe("the Node adapter never throws out of a request (S01, P092)", () => {
  const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  // A server of its own process, as an app runs it: Node's default for an uncaught exception or
  // an unhandled rejection ends that process, which this test would see.
  const script = `
    import { createServer } from "node:http";
    import { nodeHost, nodeServer } from ${module("../src/node/index.ts")};
    import { createContentHost, prefixedName } from ${module("../src/server/index.ts")};
    import { presets } from ${module("../src/index.ts")};
    const content = createContentHost({
      domain: "content.localhost",
      appOrigins: ["http://localhost:5173"],
      secret: "a test secret that is at least thirty-two bytes long",
      configs: (source) => ({ artifact: presets.artifact({ isolation: "domain", contentOrigins: [source] }) }),
      name: prefixedName("a-"),
      reserved: ["p-*"],
      instance: () => null,
      access: () => null,
    });
    const app = (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/throws") throw new Error("the app broke");
      if (path === "/rejects") return Promise.reject(new Error("the app broke later"));
      // A header fetch takes and Node can't write.
      if (path === "/unwritable") return new Response("x", { headers: { "x-said": "a\\u0001b" } });
      return new Response("the app");
    };
    const whole = nodeServer({ content, app });
    // The app's own Node listener: what it throws is answered too.
    const listener = (q, r) => {
      if (q.url === "/throws") throw new Error("the app's listener broke");
      r.end("own");
    };
    const own = createServer(nodeHost(content, { request: listener }).request);
    whole.listen(0, "127.0.0.1", () =>
      own.listen(0, "127.0.0.1", () =>
        process.stdout.write(JSON.stringify([whole.address().port, own.address().port]) + "\\n"),
      ),
    );
  `;
  /** The status line a raw request gets (one connection each). */
  const ask = (port: number, raw: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(raw));
      let said = "";
      socket.on("data", (chunk) => {
        said += String(chunk);
        if (said.includes("\r\n")) {
          socket.destroy();
          resolve(said.split("\r\n")[0] ?? "");
        }
      });
      socket.on("error", (error) => resolve(`error: ${error.message}`));
      socket.on("close", () => resolve(said === "" ? "closed" : (said.split("\r\n")[0] ?? "")));
    });
  const request = (target: string, host: string, method = "GET", more = "") =>
    `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${more}\r\n`;
  const upgrade = "Connection: Upgrade\r\nUpgrade: websocket\r\n";

  it("answers 405 and 400 for requests fetch can't take, 500 for a handler that throws or an answer Node can't write, and serves the next", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    try {
      const [whole, own] = await new Promise<[number, number]>((resolve, reject) => {
        child.stdout.once("data", (chunk) =>
          resolve(JSON.parse(String(chunk)) as [number, number]),
        );
        child.once("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
      });
      const content = "a-1.content.localhost";
      const cases: [number, string, string][] = [
        // Methods fetch can't carry, on the content domain and on the app's own host.
        [whole, request("/", content, "TRACE"), "HTTP/1.1 405 Method Not Allowed"],
        [whole, request("/", "localhost", "TRACE"), "HTTP/1.1 405 Method Not Allowed"],
        [own, request("/", content, "TRACE"), "HTTP/1.1 405 Method Not Allowed"],
        // A Host or a target that is no URL.
        [whole, request("/", "a b"), "HTTP/1.1 400 Bad Request"],
        [whole, request("/", ""), "HTTP/1.1 400 Bad Request"],
        [whole, request("*", content, "OPTIONS"), "HTTP/1.1 400 Bad Request"],
        [whole, request("http://[::1", "localhost"), "HTTP/1.1 400 Bad Request"],
        [own, request("*", content), "HTTP/1.1 400 Bad Request"],
        // The handler, and the answer's writing.
        [whole, request("/throws", "localhost"), "HTTP/1.1 500 Internal Server Error"],
        [whole, request("/rejects", "localhost"), "HTTP/1.1 500 Internal Server Error"],
        [whole, request("/unwritable", "localhost"), "HTTP/1.1 500 Internal Server Error"],
        [own, request("/throws", "localhost"), "HTTP/1.1 500 Internal Server Error"],
        // A reserved label: the app's listener, called once Porthole's fetch says it isn't its.
        [own, request("/throws", "p-1.content.localhost"), "HTTP/1.1 500 Internal Server Error"],
        // WebSockets on the content domain, converted the same way.
        [whole, request("/", content, "TRACE", upgrade), "HTTP/1.1 405 Method Not Allowed"],
        [whole, request("*", content, "GET", upgrade), "HTTP/1.1 400 Bad Request"],
        // A server without an upgrade listener: Node gives the request listener the upgrade.
        [own, request("/", content, "TRACE", upgrade), "HTTP/1.1 405 Method Not Allowed"],
      ];
      for (const [port, raw, status] of cases) {
        expect([raw.split("\r\n")[0], await ask(port, raw)]).toEqual([
          raw.split("\r\n")[0],
          status,
        ]);
      }
      // Still there, and serving.
      expect(await ask(whole, request("/", "localhost"))).toBe("HTTP/1.1 200 OK");
      expect(await ask(whole, request("/nothing", content))).toBe("HTTP/1.1 404 Not Found");
      expect(await ask(own, request("/", "localhost"))).toBe("HTTP/1.1 200 OK");
      expect(child.exitCode).toBe(null);
      expect(stderr).toBe("");
    } finally {
      child.kill();
    }
  });
});

describe("nodeHost streams (#6, P070)", () => {
  const listen = async (handler: RequestListener) => {
    const server = createHttpServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as AddressInfo).port };
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("sendResponse waits for a slow client, and cancels the body when it goes away", async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        // A fast source (a macrotask a chunk), so a writer that never waits runs away.
        async pull(controller) {
          await new Promise((resolve) => setImmediate(resolve));
          pulled += 65_536;
          controller.enqueue(new Uint8Array(65_536));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { server, port } = await listen((_request, response) => {
      void sendResponse(response, new Response(body));
    });
    try {
      const socket = connect(port, "127.0.0.1");
      socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
      socket.pause();
      await wait(400);
      // Bounded by the socket's buffers, not by how fast the body can be made.
      expect(pulled).toBeLessThan(32 * 1_048_576);
      socket.destroy();
      await vi.waitFor(() => expect(cancelled).toBe(true));
    } finally {
      server.close();
    }
  });

  it("nodeHost aborts the request's signal when the client leaves, so an upstream stops", async () => {
    const seen: { request: Request | null } = { request: null };
    let cancelled = false;
    const domain = contentDomain("content.localhost", { appOrigins: ["http://localhost:1"] });
    const fake = {
      domain,
      owns: () => true,
      access: () => Promise.resolve(null),
      fetch: (request: Request) => {
        seen.request = request;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      },
    } as unknown as Parameters<typeof nodeHost>[0];
    const { server, port } = await listen(
      nodeHost(fake, { request: (_q, r) => r.end("app") }).request,
    );
    try {
      const socket = connect(port, "127.0.0.1");
      socket.write("GET /events HTTP/1.1\r\nHost: a-1.content.localhost\r\n\r\n");
      await new Promise<void>((resolve) => socket.once("data", () => resolve()));
      socket.destroy();
      await vi.waitFor(() => {
        expect(seen.request?.signal.aborted).toBe(true);
        expect(cancelled).toBe(true);
      });
    } finally {
      server.close();
    }
  });

  it("a body that fails mid-way ends the connection: it never looks complete", async () => {
    const { server, port } = await listen((_request, response) => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            controller.error(new Error("the upstream broke"));
            return;
          }
          sent = true;
          controller.enqueue(new TextEncoder().encode("partial"));
        },
      });
      void sendResponse(response, new Response(body, { headers: { "content-length": "100" } }));
    });
    try {
      const outcome = await new Promise<string>((resolve) => {
        const asked = httpRequest({ port, host: "127.0.0.1", path: "/" }, (response) => {
          let text = "";
          response.on("data", (chunk: Buffer) => (text += chunk.toString()));
          response.on("end", () => resolve(`ended: ${text}`));
          response.on("aborted", () => resolve("aborted"));
          response.on("error", () => resolve("aborted"));
        });
        asked.on("error", () => resolve("aborted"));
        asked.end();
      });
      expect(outcome).toBe("aborted");
    } finally {
      server.close();
    }
  });
});
