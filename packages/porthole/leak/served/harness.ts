import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { expect, type Page } from "@playwright/test";
import { compile, embedderCsp, presets, type PortholeConfig } from "../../src/index.ts";
import type { ServedConformanceHost, ServedDisplay } from "../../src/conformance/served.ts";
import { checkFrameLocation } from "../../src/isolation/served.ts";
import type { FrameLocation, InstanceRef } from "../../src/isolation/types.ts";
import { createServer, proxyTo, type PortholeServer } from "../../src/server/index.ts";

/**
 * Porthole's reference serving for the served-mode cases, started in each test worker on ports of
 * its own (loopback only):
 *
 * - main: the host page on `http://127.0.0.1:<port>` and `/server` for `http://*.localhost:<port>`
 *   (browsers resolve every `*.localhost` to loopback; `localhost`'s subdomains are each a site);
 * - foreign: a page on another origin that frames content (frame-ancestors must refuse it), and
 *   the canaries, whose requests the cases count;
 * - app: a running app for url mode, reached through `proxyTo`.
 */

export interface Harness {
  readonly hostOrigin: string;
  /** The frame source every content origin matches. */
  readonly contentSource: string;
  readonly foreignOrigin: string;
  readonly porthole: PortholeServer;
  readonly configs: Readonly<Record<string, PortholeConfig>>;
  readonly hits: Map<string, number>;
  /** Artifact pages by `id@version`. */
  readonly pages: Map<string, string>;
}

export const SECRET = new Uint8Array(32).fill(42);

/** The node request as a fetch `Request`. */
function toRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, each);
    }
  }
  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD" ? null : (Readable.toWeb(request) as ReadableStream);
  return new Request(`http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`, {
    method,
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

async function send(response: ServerResponse, answer: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of answer.headers) {
    if (name !== "set-cookie") {
      headers[name] = value;
    }
  }
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) {
    headers["set-cookie"] = cookies;
  }
  response.writeHead(answer.status, headers);
  if (answer.body === null) {
    response.end();
    return;
  }
  for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
    response.write(chunk);
  }
  response.end();
}

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    server.unref();
  });

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

const HOST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Porthole served host</title></head>
<body><main id="displays"></main>
<script>
  // A minimal host: frames a located URL under the policy it is given, as a mount does.
  window.served = {
    frames: [],
    origins: [],
    received: [],
    show(url, sandbox, origin) {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", sandbox);
      frame.setAttribute("allow", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.style.cssText = "width:600px;height:240px;border:0";
      frame.src = url;
      frame.dataset.display = String(this.frames.length);
      document.getElementById("displays").append(frame);
      this.frames.push(frame);
      this.origins.push(origin);
      this.received.push([]);
      return this.frames.length - 1;
    },
    post(index, message) {
      this.frames[index].contentWindow.postMessage(message, this.origins[index]);
    },
    remove(index) {
      this.frames[index].remove();
    },
  };
  // A frame's messages are taken from its window and its located origin only.
  window.addEventListener("message", (event) => {
    const index = window.served.frames.findIndex((frame) => frame.contentWindow === event.source);
    if (index !== -1 && event.origin === window.served.origins[index]) {
      window.served.received[index].push(event.data);
    }
  });
</script></body></html>`;

const APP_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head>
<body><p>A running app.</p><script src="/app.js"></script></body></html>`;

const PACKAGE = path.resolve(import.meta.dirname, "../..");

/** The package's own TypeScript, stripped as Node strips it, for a host page to import. */
async function sourceOf(pathname: string): Promise<Response | null> {
  const relative = pathname.replace(/^\/+/u, "");
  if (!/^(src|leak\/mcp)\/[\w/.-]+\.ts$/u.test(relative) || relative.includes("..")) {
    return null;
  }
  try {
    const text = await readFile(path.join(PACKAGE, relative), "utf8");
    return new Response(stripTypeScriptTypes(text), {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return null;
  }
}

/**
 * A host page on Porthole's own `createHost`, mounting served instances at the locations a test
 * gives it and recording their outcomes (P040). Served on the host origin and the foreign one.
 */
const PORTHOLE_HOST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Porthole host</title></head>
<body><main id="displays"></main><script type="module">
  import { createHost } from "/src/index.ts";
  window.portholeHost = {
    records: [],
    mount(config, location, instance) {
      const index = this.records.length;
      const record = { outcomes: [], initialized: false, errors: [] };
      this.records.push(record);
      const box = document.createElement("section");
      box.style.cssText = "width: 600px; height: 300px";
      document.getElementById("displays").append(box);
      const host = createHost(config, { locator: { locate: async () => location } });
      const display = host.mount(box, { displayId: "d" + index, title: "Probe", scheme: "light", instance });
      display.on("outcome", (outcome) => record.outcomes.push(outcome));
      display.on("initialized", () => (record.initialized = true));
      display.on("error", ({ message }) => record.errors.push(message));
      return index;
    },
  };
</script></body></html>`;

/** A host page for MCP Apps views, on Porthole's own adapter (`leak/mcp/host.ts`). */
const MCP_HOST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Porthole MCP Apps host</title></head>
<body><main id="displays"></main><script type="module" src="/leak/mcp/host.ts"></script></body></html>`;

let hostCspOf = (): string => "frame-src 'none'";

async function start(): Promise<Harness> {
  const hits = new Map<string, number>();
  const pages = new Map<string, string>(
    ["1", "2"].map((version) => [
      `page@${version}`,
      `<!doctype html><html><head><title>Page</title></head><body><main id="artifact">version ${version}</main><script>document.documentElement.dataset.rtc = typeof RTCPeerConnection;</script></body></html>`,
    ]),
  );

  const app = createHttpServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://app").pathname;
    if (pathname === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end('document.documentElement.dataset.app = "ready";');
      return;
    }
    response.writeHead(pathname === "/" ? 200 : 404, { "content-type": "text/html" });
    response.end(pathname === "/" ? APP_PAGE : "not found");
  });
  const appPort = await listen(app);

  const foreign = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://foreign");
    const canary = /^\/canary\/([a-z0-9-]+)$/u.exec(url.pathname);
    if (canary?.[1] !== undefined) {
      hits.set(canary[1], (hits.get(canary[1]) ?? 0) + 1);
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/porthole-host") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": hostCspOf(),
      });
      response.end(PORTHOLE_HOST_PAGE);
      return;
    }
    if (url.pathname.startsWith("/src/")) {
      void sourceOf(url.pathname).then(async (source) => {
        response.writeHead(source === null ? 404 : 200, { "content-type": "text/javascript" });
        response.end(source === null ? "" : await source.text());
      });
      return;
    }
    const target = url.searchParams.get("frame") ?? "";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><title>Foreign</title><iframe sandbox="allow-scripts allow-same-origin" src="${target.replace(/"/gu, "&quot;")}"></iframe>`,
    );
  });
  const foreignPort = await listen(foreign);

  let handle: (request: Request) => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 503 }));
  const main = createHttpServer((request, response) => {
    handle(toRequest(request)).then(
      (answer) => send(response, answer),
      () => response.writeHead(500).end(),
    );
  });
  const port = await listen(main);
  const hostOrigin = `http://127.0.0.1:${port}`;
  const contentSource = `http://*.localhost:${port}`;
  const configs: Record<string, PortholeConfig> = {
    inlineWidget: presets.inlineWidget({ isolation: "domain", contentOrigins: [contentSource] }),
    artifact: presets.artifact({ isolation: "domain", contentOrigins: [contentSource] }),
    mcpApp: presets.mcpApp({ isolation: "domain", contentOrigins: [contentSource] }),
    url: presets.url({ contentOrigins: [contentSource] }),
  };
  const porthole = createServer({
    content: { domain: "localhost", scheme: "http", port },
    secret: SECRET,
    hostOrigins: [hostOrigin],
    configs,
    artifacts: {
      get: async (id, version) => {
        const page = pages.get(`${id}@${version}`);
        return page === undefined ? null : { html: page };
      },
    },
    upstream: proxyTo({ target: () => `http://127.0.0.1:${appPort}` }),
  });
  const hostCsp = embedderCsp(Object.values(configs));
  hostCspOf = () => hostCsp;
  handle = async (request) => {
    // A content address that never answers: a load that never settles.
    if (new URL(request.url).pathname === "/__hang") {
      return new Promise<Response>(() => {});
    }
    const served = await porthole.handle(request);
    if (served !== null) {
      return served;
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === "/host") {
      return html(HOST_PAGE, { "content-security-policy": hostCsp });
    }
    if (pathname === "/porthole-host") {
      return html(PORTHOLE_HOST_PAGE, { "content-security-policy": hostCsp });
    }
    if (pathname === "/mcp-host") {
      return html(MCP_HOST_PAGE, { "content-security-policy": hostCsp });
    }
    const source = await sourceOf(pathname);
    return source ?? new Response("not found", { status: 404 });
  };
  return {
    hostOrigin,
    contentSource,
    foreignOrigin: `http://127.0.0.1:${foreignPort}`,
    porthole,
    configs,
    hits,
    pages,
  };
}

let started: Promise<Harness> | null = null;
/** The worker's harness, started on first use. */
export const harness = (): Promise<Harness> => (started ??= start());

/** The config an instance is framed under, as a host's mount picks it. */
export function configOf(served: Harness, instance: InstanceRef): PortholeConfig {
  const { document } = instance;
  const name =
    document.kind === "external"
      ? "url"
      : document.kind === "shell"
        ? document.preset
        : (document.preset ?? (document.kind === "artifact" ? "artifact" : "mcpApp"));
  const config = served.configs[name];
  if (config === undefined) {
    throw new Error(`no config ${name}`);
  }
  return config;
}

interface Served {
  show(url: string, sandbox: string, origin: string): number;
  remove(index: number): void;
  post(index: number, message: unknown): void;
  received: unknown[][];
}

/** Shows a located instance in the harness's host page, checked as a mount checks it. */
export async function showServed(
  page: Page,
  instance: InstanceRef,
): Promise<ServedDisplay & { location: FrameLocation }> {
  const served = await harness();
  if (!page.url().startsWith(`${served.hostOrigin}/host`)) {
    await page.goto(`${served.hostOrigin}/host`);
  }
  const config = configOf(served, instance);
  const location = await served.porthole.issue(instance, { viewer: "probe" });
  checkFrameLocation(location, config.contentOrigins, served.hostOrigin);
  const index = await page.evaluate(
    ([url, sandbox, origin]) =>
      (window as unknown as { served: Served }).served.show(url, sandbox, origin),
    [location.url, compile(config).sandbox, location.origin] as const,
  );
  const element = page.locator(`#displays iframe[data-display="${index}"]`);
  return {
    origin: location.origin,
    location,
    async frame() {
      const frame = await (await element.elementHandle())?.contentFrame();
      if (frame === null || frame === undefined) {
        throw new Error("the display has no frame");
      }
      await frame.waitForURL((url) => url.origin === location.origin);
      // A framed app is entered through a page that goes on to the app or, where the browser
      // keeps no cookie in a frame (WebKit, P025), stays and says so (P040): wait for either.
      await expect
        .poll(
          () =>
            frame
              .evaluate(
                () =>
                  document.querySelector("[data-porthole-enter]") === null ||
                  /new tab/u.test(document.querySelector("h1")?.textContent ?? ""),
              )
              .catch(() => false),
          { timeout: 10_000 },
        )
        .toBe(true);
      await frame.waitForLoadState("load");
      return frame;
    },
    async destroy() {
      await page.evaluate(
        (each) => (window as unknown as { served: Served }).served.remove(each),
        index,
      );
    },
    async post(message) {
      await page.evaluate(
        ([each, data]) => (window as unknown as { served: Served }).served.post(each, data),
        [index, message] as const,
      );
    },
    received: () =>
      page.evaluate(
        (each) => (window as unknown as { served: Served }).served.received[each] ?? [],
        index,
      ),
  };
}

/** The reference host for the served-mode conformance cases. */
export const servedHost: ServedConformanceHost = {
  name: "reference",
  show: (page, instance) => showServed(page, instance),
  locate: async (instance) => (await harness()).porthole.issue(instance, { viewer: "probe" }),
  async frameFromForeignOrigin(page, url) {
    const served = await harness();
    await page.goto(`${served.foreignOrigin}/?frame=${encodeURIComponent(url)}`);
  },
  canary: async (name) => `${(await harness()).foreignOrigin}/canary/${name}`,
  canaryHits: async (name) => (await harness()).hits.get(name) ?? 0,
  shell: (scope) => ({ scope, document: { kind: "shell", preset: "inlineWidget" } }),
  // The upstream finds the app itself (`proxyTo`'s target): the URL only gives the landing path.
  app: (scope) => ({ scope, document: { kind: "external", url: "http://app.test/" } }),
  artifact: (scope, version) => ({
    scope,
    document: { kind: "artifact", id: "page", version },
  }),
  proxy: (scope, egress) => ({
    scope,
    document: { kind: "mcp-proxy", ...(egress === undefined ? {} : { egress }) },
  }),
};
