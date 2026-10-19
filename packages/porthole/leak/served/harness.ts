import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { expect, type Page } from "@playwright/test";
import {
  compile,
  embedderCsp,
  LIBRARY_CDNS,
  presets,
  type PortholeConfig,
} from "../../src/index.ts";
import type { ServedConformanceHost, ServedDisplay } from "../../src/conformance/served.ts";
import { checkFrameLocation } from "../../src/isolation/served.ts";
import type { FrameLocation, InstanceRef } from "../../src/isolation/types.ts";
import {
  createServer,
  proxyTo,
  type PortholeServer,
  type StoredAsset,
  type StoredFiles,
} from "../../src/server/index.ts";
import { checkWeakenings, weaken, weakenServed, weakened } from "../weakenings.ts";
import { asServiceWorkerAllowed, withoutResourcePolicy, withSelfForFiles } from "./files.ts";

/**
 * Porthole's reference serving for the served-mode cases, started in each test worker on ports of
 * its own (loopback only):
 *
 * - main: the host page on `http://127.0.0.1:<port>` and `/server` for `http://*.localhost:<port>`
 *   (browsers resolve every `*.localhost` to loopback; `localhost`'s subdomains are each a site);
 * - foreign: a page on another origin that frames content (frame-ancestors must refuse it), and
 *   the canaries, whose requests the cases count;
 * - app: a running app for url mode, reached through `proxyTo`.
 *
 * The server asks the host's check on every request (P050): a subject in `revoked` is denied.
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
  /** Artifact versions made of files by `id@version` (P081): a case publishes into it. */
  readonly fileSets: Map<string, StoredFiles>;
  /** Subjects the host has revoked: their tickets and cookies are denied from the next request. */
  readonly revoked: Set<string>;
  /** Every URL the main server (host page and content origins) was asked for, in order. */
  readonly requests: string[];
  /**
   * Artifacts' asset libraries (P089), by id: what `/server` serves at `/_blob/<id>`. The host
   * page's reference services add to it (`POST /__assets`), and a case may too.
   */
  readonly assets: Map<string, StoredAsset>;
}

/** A library as a CDN serves it, for the CDN cases (routed by the test, never fetched). */
export const CDN_LIBRARY = "https://cdn.jsdelivr.net/npm/porthole-probe-lib@1.0.0/index.min.js";

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
  if (!/^(src|leak\/mcp|leak\/runtime)\/[\w/.-]+\.ts$/u.test(relative) || relative.includes("..")) {
    return null;
  }
  let source: string;
  try {
    source = await readFile(path.join(PACKAGE, relative), "utf8");
  } catch {
    return null;
  }
  // A control whose text is gone fails loudly (after the review): never a quiet 404 that looks
  // like the control working.
  const text = weaken(relative, source);
  return new Response(stripTypeScriptTypes(text), {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * A host page on Porthole's own `createHost`, mounting served instances at the locations a test
 * gives it and recording their outcomes (P040). Served on the host origin and the foreign one.
 */
const PORTHOLE_HOST_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Porthole host</title></head>
<body><main id="displays"></main><script type="module">
  import { createHost, Refused } from "/src/index.ts";
  import { memoryRuntime } from "/leak/runtime/memory.ts";
  // The capability runtime's reference services (P085-P090), in memory, one per key a case names
  // (two people's displays share one): their calls are the cases' oracle. Assets go to the
  // harness's server too, which serves them at /_blob/<id>.
  const runtimes = (window.runtimes = new Map());
  const keep = (asset, removed) =>
    fetch("/__assets", {
      method: removed ? "DELETE" : "POST",
      body: JSON.stringify({ id: asset.id, scope: asset.scope, artifact: asset.artifact, trusted: asset.trusted, name: asset.name, sha256: asset.sha256, base64: removed ? "" : btoa(String.fromCharCode(...asset.bytes)) }),
    });
  const runtimeOf = (options) => {
    if (!runtimes.has(options.key)) {
      runtimes.set(options.key, memoryRuntime({
        scope: options.scope,
        artifact: options.artifact,
        uploadLevel: options.uploadLevel,
        onAsset: keep,
        // The app's composer answers with a thread; content must hear only whether it opened.
        composer: () => ({ thread: "a reply only the app sees" }),
      }));
    }
    return runtimes.get(options.key);
  };
  // The host's side of each subscription to the runtime's services, by key and URI: a case pushes
  // a result through it, as a host's changed(result) does (P094).
  const pushes = (window.runtimePushes = new Map());
  const withPushes = (key, handlers) => ({
    ...handlers,
    subscribeData: (args, context) => {
      pushes.set(key + " " + args.uri, context.changed);
      return handlers.subscribeData(args, context);
    },
  });
  // A host's data for live widgets (P079): resources by URI as JSON, their subscribers, the
  // viewer's consent (asked once per display) and a cache of last values.
  const liveData = (window.liveData = {
    consent: true,
    asked: 0,
    reads: [],
    values: new Map([["app://counter", { n: 1 }]]),
    cache: new Map(),
    // Reads the host refuses, by URI, with the reason content is told (P080).
    refusals: new Map(),
    subscribers: new Map(),
    set(uri, value) {
      this.values.set(uri, value);
      for (const changed of this.subscribers.get(uri) ?? []) changed();
    },
  });
  const result = (uri, value) => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value ?? null) }] });
  const liveOptions = () => ({
    handlers: {
      readData: ({ uri }) => {
        liveData.reads.push(uri);
        const refused = liveData.refusals.get(uri);
        if (refused) {
          throw new Refused(refused.code, refused.message);
        }
        return result(uri, liveData.values.get(uri));
      },
      subscribeData: ({ uri }, { changed, signal }) => {
        const set = liveData.subscribers.get(uri) ?? new Set();
        set.add(changed);
        liveData.subscribers.set(uri, set);
        signal.addEventListener("abort", () => set.delete(changed));
      },
    },
    consent: () => {
      liveData.asked += 1;
      return liveData.consent;
    },
    cached: ({ uri }) => (liveData.cache.has(uri) ? result(uri, liveData.cache.get(uri)) : undefined),
  });
  window.portholeHost = {
    records: [],
    displays: [],
    mount(config, location, instance, options = {}) {
      const index = this.records.length;
      const record = { outcomes: [], initialized: false, errors: [], contentErrors: [], hostErrors: [], navigationsBlocked: [] };
      this.records.push(record);
      const box = document.createElement("section");
      box.style.cssText = "width: 600px; height: 300px";
      document.getElementById("displays").append(box);
      // A null location: the host's backend failing to give one.
      const runtime = options.runtime ? runtimeOf(options.runtime) : null;
      const host = createHost(config, {
        // The runtime's services, a person who says yes to every confirmation and consent.
        ...(runtime === null
          ? {}
          : { handlers: withPushes(options.runtime.key, runtime.handlers), confirm: async () => true, consent: () => true }),
        // "refused": a page where live data never runs: consent a Refused, no handlers (P080).
        ...(options.live === "refused"
          ? { consent: new Refused("not_allowed", "Live data shows on the dashboard.") }
          : options.live
            ? liveOptions()
            : {}),
        locator: {
          locate: async () => {
            if (location === null) {
              throw new Error("The host's backend is down");
            }
            return location;
          },
        },
      });
      const display = host.mount(box, {
        displayId: "d" + index,
        title: "Probe",
        scheme: "light",
        instance,
        ...(options.fill ? { fill: true } : {}),
        // The page's declaration, or the host's explicit null for a page from before 0.7 (P086).
        ...(options.runtime && "declaration" in options.runtime ? { declaration: options.runtime.declaration } : {}),
        ...(options.runtime && options.runtime.viewer ? { viewer: options.runtime.viewer } : {}),
      });
      this.displays.push(display);
      if (typeof options.content === "string") {
        display.setContent(options.content);
      }
      display.on("outcome", (outcome) => record.outcomes.push(outcome));
      display.on("initialized", () => (record.initialized = true));
      display.on("error", ({ message, source }) => record.errors.push(source + ": " + message));
      display.on("contentError", ({ message }) => record.contentErrors.push(message));
      display.on("hostError", (error) => record.hostErrors.push(error));
      display.on("navigationBlocked", ({ url }) => record.navigationsBlocked.push(url));
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
  checkWeakenings((relative) => readFileSync(path.join(PACKAGE, relative), "utf8"));
  const hits = new Map<string, number>();
  const pages = new Map<string, string>(
    ["1", "2"].map((version) => [
      `page@${version}`,
      `<!doctype html><html><head><title>Page</title></head><body><main id="artifact">version ${version}</main><script>document.documentElement.dataset.rtc = typeof RTCPeerConnection;</script></body></html>`,
    ]),
  );

  pages.set(
    "cdn@1",
    `<!doctype html><html><head><title>Chart</title><script src="${CDN_LIBRARY}"></script></head><body><main id="artifact">a page with a library</main></body></html>`,
  );
  const revoked = new Set<string>();
  const requests: string[] = [];
  const fileSets = new Map<string, StoredFiles>();
  const assets = new Map<string, StoredAsset>();

  const app = createHttpServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://app").pathname;
    if (pathname === "/api") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"ok":true}');
      return;
    }
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
    if (url.pathname.startsWith("/src/") || url.pathname.startsWith("/leak/runtime/")) {
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
    // A shell whose images and media load from any https site (P059).
    inlineAnyHttps: presets.inlineWidget({
      isolation: "domain",
      contentOrigins: [contentSource],
      egress: { anyHttps: ["img", "media"] },
    }),
    artifactCdn: presets.artifact({
      isolation: "domain",
      contentOrigins: [contentSource],
      egress: LIBRARY_CDNS,
    }),
    mcpApp: presets.mcpApp({ isolation: "domain", contentOrigins: [contentSource] }),
    // A live widget (P079): no network of its own, Porthole's libraries on its origin.
    liveWidget: presets.liveWidget({ isolation: "domain", contentOrigins: [contentSource] }),
    // The capability runtime (P085-P090): every capability; uploads the admins' (scripts from the
    // asset library run), or open to people who interact (they never do).
    runtime: presets.artifact({
      isolation: "domain",
      contentOrigins: [contentSource],
      runtime: "1",
      capabilities: RUNTIME_CAPABILITIES_ALL,
    }),
    runtimeOpen: presets.artifact({
      isolation: "domain",
      contentOrigins: [contentSource],
      runtime: "1",
      capabilities: { ...RUNTIME_CAPABILITIES_ALL, assets: { levels: { upload: "interact" } } },
    }),
    // A 0.6 page's config: no runtime (copy buttons and data, as before).
    artifactLegacy: presets.artifact({
      isolation: "domain",
      contentOrigins: [contentSource],
      capabilities: { copyText: {}, readData: {}, subscribeData: {} },
    }),
    url: presets.url({ contentOrigins: [contentSource] }),
  };
  const porthole = createServer({
    content: { domain: "localhost", scheme: "http", port },
    secret: SECRET,
    hostOrigins: [hostOrigin],
    configs,
    artifacts: {
      get: async (id, version) => {
        const files = fileSets.get(`${id}@${version}`);
        if (files !== undefined) {
          return files;
        }
        const page = pages.get(`${id}@${version}`);
        return page === undefined ? null : { html: page };
      },
    },
    upstream: proxyTo({ target: () => `http://127.0.0.1:${appPort}` }),
    assets: { get: (id) => Promise.resolve(assets.get(id) ?? null) },
    ...(weakened.includes("authorize")
      ? {}
      : {
          authorize: {
            check: ({ subject }: { readonly subject?: string }) =>
              subject !== undefined && revoked.has(subject)
                ? ({ allow: false, code: "revoked" } as const)
                : ({ allow: true } as const),
          },
        }),
  });
  const hostCsp = embedderCsp(Object.values(configs));
  hostCspOf = () => hostCsp;
  handle = async (request) => {
    requests.push(request.url);
    // A content address that never answers: a load that never settles.
    if (new URL(request.url).pathname === "/__hang") {
      return new Promise<Response>(() => {});
    }
    const served = await porthole.handle(
      weakened.includes("service-worker") ? asServiceWorkerAllowed(request) : request,
    );
    if (served !== null) {
      // The harness's controls, each applied in turn, so several combine (after the review).
      let answer = served;
      const pathname = new URL(request.url).pathname;
      const blob = pathname.startsWith("/_blob/") || pathname.includes("/__porthole/blob/");
      // The asset library (P089): its code runs whoever uploads; an asset opened on its own runs;
      // an untrusted script is served as one.
      if (weakened.includes("blob-script")) {
        answer = withAssetScripts(answer, request);
      }
      if (weakened.includes("blob-inert") && blob) {
        const headers = new Headers(answer.headers);
        headers.delete("content-security-policy");
        answer = new Response(answer.body, { status: answer.status, headers });
      }
      if (weakened.includes("blob-trusted") && blob && answer.status === 200) {
        const headers = new Headers(answer.headers);
        if (headers.get("content-type") === "application/octet-stream") {
          headers.set("content-type", "text/javascript; charset=utf-8");
          headers.delete("content-disposition");
        }
        answer = new Response(answer.body, { status: answer.status, headers });
      }
      if (weakened.includes("file-self")) {
        answer = withSelfForFiles(answer);
      }
      if (weakened.includes("file-corp")) {
        answer = withoutResourcePolicy(answer);
      }
      // A negative control on the shell's navigation guard reaches served shells too (P079).
      if (
        weakened.includes("navigate-guard") &&
        (answer.headers.get("content-type") ?? "").startsWith("text/html")
      ) {
        answer = new Response(weakenServed(await answer.text()), {
          status: answer.status,
          headers: answer.headers,
        });
      }
      return answer;
    }
    const pathname = new URL(request.url).pathname;
    // The host page's services keep assets here (P089): the bytes /_blob/<id> serves.
    if (pathname === "/__assets" && (request.method === "POST" || request.method === "DELETE")) {
      const body = (await request.json()) as {
        id: string;
        scope: string;
        artifact: string;
        trusted: boolean;
        name: string;
        sha256: string;
        base64: string;
      };
      if (request.method === "DELETE") {
        assets.delete(body.id);
      } else {
        assets.set(
          body.id,
          storedAsset(body.scope, body.name, Buffer.from(body.base64, "base64"), {
            artifact: body.artifact,
            trusted: body.trusted,
          }),
        );
      }
      return new Response(null, { status: 204 });
    }
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
    fileSets,
    revoked,
    requests,
    assets,
  };
}

/** The host functions the runtime configs offer: every one. */
const RUNTIME_CAPABILITIES_ALL = {
  copyText: {},
  openLink: {},
  downloadFile: {},
  sendPrompt: {},
  readData: {},
  subscribeData: {},
  callTool: {},
  setModelContext: {},
  user: {},
  comments: {},
  artifact: {},
  assets: {},
  db: {},
} as const;

/** An asset as the harness's store keeps it. */
export function storedAsset(
  scope: string,
  name: string,
  bytes: Uint8Array,
  owner: { readonly artifact: string; readonly trusted?: boolean },
): StoredAsset {
  return {
    scope,
    artifact: owner.artifact,
    ...(owner.trusted === true ? { trusted: true } : {}),
    name,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    read: () => Promise.resolve(new Uint8Array(bytes)),
  };
}

/**
 * The `blob-script` control (P089): every served page's scripts and styles may load from its
 * asset library, whoever uploaded to it.
 */
function withAssetScripts(served: Response, request: Request): Response {
  const csp = served.headers.get("content-security-policy");
  if (csp === null || !csp.includes("/_blob/")) {
    return served;
  }
  const origin = new URL(request.url).origin;
  const headers = new Headers(served.headers);
  headers.set(
    "content-security-policy",
    csp
      .split("; ")
      .map((each) =>
        (each.startsWith("script-src ") || each.startsWith("style-src ")) &&
        !each.includes("/_blob/")
          ? `${each} ${origin}/_blob/`
          : each,
      )
      .join("; "),
  );
  return new Response(served.body, { status: served.status, headers });
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
