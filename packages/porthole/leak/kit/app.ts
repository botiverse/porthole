import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { presets, type PortholeConfig } from "../../src/index.ts";
import type { InstanceRef } from "../../src/isolation/types.ts";
import { nodeHost, nodeProbe, sendResponse, toRequest } from "../../src/node/index.ts";
import {
  conformancePage,
  createContentHost,
  prefixedName,
  proxyTo,
  type ContentHost,
  type ContentHostEvent,
} from "../../src/server/index.ts";

/**
 * The host kit's reference app (P066): an app as an adopter writes it, on `createContentHost` and
 * `nodeHost`, with a page that sends a strict nonce CSP. The conformance runner points at it on
 * loopback (`leak/kit.spec.ts`) and, behind Caddy's TLS on same-site siblings, in the prod-shape
 * profile (`ops/prod-shape`). Its policy is a small one:
 * - a viewer is whoever signed in (`/login?as=<name>`, a cookie);
 * - a scope is any label-safe id the client proposes (in a real app: a session, an artifact);
 * - a shell's preset, a stored page's version and a running app are the server's to choose.
 */

export interface KitSettings {
  readonly port: number;
  /** `http://localhost:<port>`; behind TLS, `https://app.test`. */
  readonly appOrigin: string;
  /** `kitcontent.localhost:<port>`; behind TLS, `content.test`. */
  readonly contentDomain: string;
  readonly secret?: string;
  /** The health gate and the opaque fallback (default on). */
  readonly health?: boolean;
  /** Where the app listens (default 127.0.0.1; in a container, 0.0.0.0). */
  readonly listen?: string;
}

/** The configs content is served under, by name, for a content source. */
export function kitConfigs(source: string): Record<string, PortholeConfig> {
  return {
    inlineWidget: presets.inlineWidget({ isolation: "domain", contentOrigins: [source] }),
    artifact: presets.artifact({ isolation: "domain", contentOrigins: [source] }),
    url: presets.url({ contentOrigins: [source] }),
  };
}

/** The config an instance is framed under, as the app's client picks it. */
export function kitConfigOf(source: string, instance: InstanceRef): PortholeConfig {
  const { document } = instance;
  const name =
    document.kind === "shell"
      ? document.preset
      : document.kind === "artifact"
        ? (document.preset ?? "artifact")
        : document.kind === "external"
          ? "url"
          : "none";
  const config = kitConfigs(source)[name];
  if (config === undefined) {
    throw new Error(`the kit app has no config ${name}`);
  }
  return config;
}

/** Stored pages: two versions of one, as the served cases ask. */
const PAGES = new Map(
  (["1", "2"] as const).map((version) => [`page@${version}`, conformancePage(version)]),
);

const SCOPE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const VIEWER = /^[a-z0-9-]{1,32}$/u;

/** A running app for url mode: its page loads a script from its own origin. */
async function runningApp(): Promise<{ readonly url: string; readonly server: Server }> {
  const server = createHttpServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://app").pathname;
    if (pathname === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end('document.documentElement.dataset.app = "ready";');
      return;
    }
    response.writeHead(pathname === "/" ? 200 : 404, { "content-type": "text/html" });
    response.end(
      pathname === "/"
        ? '<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body><p>A running app.</p><script src="/app.js"></script></body></html>'
        : "not found",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server };
}

const viewerOf = (request: Request): string | null => {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, value = ""] = pair.trim().split("=");
    if (name === "kit-viewer" && VIEWER.test(value)) {
      return value;
    }
  }
  return null;
};

const escape = (text: string): string =>
  text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The app's page. Its "open in a new tab" is the page's clean address (`urlOf`), never a ticket:
 * it opens for whoever has access, through the app's own sign-in.
 */
const page = (nonce: string, viewer: string | null, demo: string | null) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kit app</title>
<script nonce="${nonce}">window.kitApp = { viewer: ${JSON.stringify(viewer)} };</script>
</head><body><main id="app">${viewer === null ? "Signed out" : `Signed in as ${escape(viewer)}`}
${demo === null ? "" : `<p><a id="open-tab" href="${escape(demo)}" target="_blank" rel="noopener">Open the demo page in a new tab</a></p>`}
</main></body></html>`;

/** The app's own sign-in: a person picks who they are, and comes back where they were going. */
const SIGN_IN = (next: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head><body><main id="sign-in-page">
<h1>Sign in to the kit app</h1>
<p><a id="sign-in" href="/login?as=probe&amp;next=${encodeURIComponent(next)}">Sign in as probe</a></p>
</main></body></html>`;

/** Only a path of the app's own comes back from sign-in: never another site's address. */
const ownPath = (next: string | null): string =>
  next !== null && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\")
    ? next
    : "/";

/** A preview's page: frames what `?frame=` names, and runs what the test evaluates in it. */
const PREVIEW = `<!doctype html><html><head><meta charset="utf-8"><title>Preview</title></head><body>
<p id="preview">A preview on a sibling label.</p>
<script>
  const frame = new URLSearchParams(location.search).get("frame");
  if (frame) {
    const element = document.createElement("iframe");
    element.src = frame;
    document.body.append(element);
  }
</script></body></html>`;

export interface Kit {
  readonly server: Server;
  readonly content: ContentHost<string>;
  readonly events: ContentHostEvent[];
  close(): void;
}

/** Starts the kit app; resolves once it listens and has checked its content domain once. */
export async function startKit(settings: KitSettings): Promise<Kit> {
  const app = await runningApp();
  const events: ContentHostEvent[] = [];
  const revoked = new Set<string>();
  const secure = settings.appOrigin.startsWith("https:");
  const content = createContentHost<string>({
    domain: settings.contentDomain,
    // A desktop app's own scheme beside the web origin, as Ferry's is (`ferry://app`): the
    // content's pages must still talk to the web page that frames them (#5, P070).
    appOrigins: [settings.appOrigin, "porthole-kit://app"],
    secret: settings.secret ?? randomBytes(32).toString("base64url"),
    configs: kitConfigs,
    name: prefixedName("k-"),
    reserved: ["p-*"],
    // Policy 1: the instance a request proposes, as the app means it.
    instance: (proposal) => {
      if (!SCOPE.test(proposal.scope)) {
        return null;
      }
      const { scope, document } = proposal;
      switch (document.kind) {
        case "shell":
          return document.preset === "inlineWidget"
            ? { scope, document: { kind: "shell", preset: "inlineWidget" } }
            : null;
        case "artifact":
          return PAGES.has(`${document.id}@${document.version}`)
            ? { scope, document: { kind: "artifact", id: document.id, version: document.version } }
            : null;
        case "external":
          return { scope, document: { kind: "external", url: app.url } };
        default:
          return null;
      }
    },
    // Policy 2: who may see it. Here, anyone signed in; a scope named secret-* no one.
    access: (instance, viewer) =>
      viewer === null || instance.scope.startsWith("secret-") ? null : { viewer, subject: viewer },
    // Policy 3: may this cookie still see it.
    authorize: ({ subject }) =>
      subject !== undefined && revoked.has(subject)
        ? { allow: false, code: "revoked" }
        : { allow: true },
    // Policy 4: a stored page.
    source: (id, version) => {
      const html = PAGES.get(`${id}@${version}`);
      return Promise.resolve(html === undefined ? null : { html });
    },
    upstream: proxyTo(),
    // Clean addresses (P068): a scope's / is its stored page's first version, /v/2 its second.
    entry: {
      authorizeUrl: `${settings.appOrigin}/porthole/authorize`,
      at: (scope, path) => {
        const version = path === "/" ? "1" : /^\/v\/([12])$/u.exec(path)?.[1];
        return version === undefined || !SCOPE.test(scope)
          ? null
          : { scope, document: { kind: "artifact", id: "page", version } };
      },
      signIn: (returnTo) => {
        const back = new URL(returnTo);
        return new Response(null, {
          status: 303,
          headers: {
            location: `/signin?next=${encodeURIComponent(`${back.pathname}${back.search}`)}`,
          },
        });
      },
      refusal: (status) =>
        new Response(
          `<!doctype html><title>No access</title><main id="refusal">${status === 403 ? "You don't have access to this page." : "There is no such page."}</main>`,
          { status, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    },
    ...(settings.health === false ? {} : { health: { probe: nodeProbe() } }),
    log: (event) => {
      events.push(event);
      console.log(JSON.stringify(event));
    },
  });
  const issue = content.issue(viewerOf);
  const authorize = content.authorize(viewerOf);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });

  // The app's own routes, as a fetch handler (an adopter's would be Express or Hono).
  const appRoutes = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // A reserved label is the app's own (a preview of someone's dev server, as Ferry's are): a
    // same-site sibling of every content origin that isn't Porthole's, so the prod-shape checks
    // can attack content from it.
    if (content.domain?.labelOf(url.host)?.startsWith("p-") === true) {
      return new Response(PREVIEW, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/porthole/authorize") {
      return authorize(request);
    }
    if (url.pathname === "/signin") {
      return new Response(SIGN_IN(ownPath(url.searchParams.get("next"))), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        },
      });
    }
    if (url.pathname === "/login") {
      const as = url.searchParams.get("as") ?? "";
      if (!VIEWER.test(as)) {
        return new Response("bad name", { status: 400 });
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: ownPath(url.searchParams.get("next")),
          "set-cookie": `kit-viewer=${as}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
        },
      });
    }
    if (url.pathname === "/api/frames") {
      return issue(request);
    }
    if (url.pathname === "/api/meta") {
      return json(content.meta());
    }
    if (url.pathname === "/api/events") {
      return json(events);
    }
    if (url.pathname === "/api/revoke" && request.method === "POST") {
      const viewer = viewerOf(request);
      if (viewer !== null) {
        revoked.add(viewer);
      }
      return json({ revoked: viewer });
    }
    if (url.pathname === "/") {
      const nonce = randomBytes(18).toString("base64");
      const frames = content.frameSources.length === 0 ? "'none'" : content.frameSources.join(" ");
      return new Response(page(nonce, viewerOf(request), content.urlOf("demo")), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          // A strict page, as a careful app sends it: scripts by nonce only, frames from content.
          "content-security-policy": `script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-src ${frames}; frame-ancestors 'none'`,
        },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const porthole = nodeHost(content, {
    request: (request, response) => {
      appRoutes(toRequest(request, secure ? "https" : "http")).then(
        (answer) => sendResponse(response, answer),
        () => response.writeHead(500).end(),
      );
    },
  });
  const server = createHttpServer(porthole.request);
  server.on("upgrade", porthole.upgrade);
  await new Promise<void>((resolve) =>
    server.listen(settings.port, settings.listen ?? "127.0.0.1", resolve),
  );
  content.start();
  await content.check();
  return {
    server,
    content,
    events,
    close() {
      content.close();
      server.close();
      app.server.close();
    },
  };
}
