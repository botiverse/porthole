import { presets } from "../../src/index.ts";
import {
  createContentHost,
  createServer,
  d1TicketStore,
  prefixedName,
  type ContentHost,
  type D1Like,
} from "../../src/server/index.ts";

/**
 * A Cloudflare Worker serving Porthole content the way a host would wire it (P044): `/server` on a
 * flat content domain, tickets in D1, the host's per-request check, and a test-only route to mint
 * tickets (a real host mints them from its own authenticated API).
 */

interface Env {
  readonly DB: D1Like;
  readonly SECRET: string;
}

const CONTENT = "usercontent.test";

/** workerd's WebSocket pair (not in the DOM's types): two ends, one for the client. */
declare const WebSocketPair: new () => { 0: WebSocket; 1: WebSocket & { accept(): void } };
const HOST = "https://artifacts.example";

/** A version made of files (P081), its bytes streamed as a store (R2) streams them. */
function site(version: string) {
  const files: Record<string, Uint8Array> = {
    "index.html": new TextEncoder().encode(
      `<!doctype html><link rel="stylesheet" href="./style.css"><h1 id="v">site ${version}</h1>`,
    ),
    "style.css": new TextEncoder().encode("h1 { color: red; }"),
    "clip.mp4": new Uint8Array(Array.from({ length: 256 }, (_, index) => index)),
  };
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [
        path,
        { size: bytes.byteLength, sha256: "0".repeat(64) },
      ]),
    ),
    read: async (path: string) => {
      const bytes = files[path];
      return bytes === undefined
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              for (let at = 0; at < bytes.byteLength; at += 64) {
                controller.enqueue(bytes.slice(at, at + 64));
              }
              controller.close();
            },
          });
    },
  };
}

/** Revoked subjects, as a host's database would hold them. */
const revoked = new Set<string>();

let server: ReturnType<typeof createServer> | null = null;
function porthole(env: Env) {
  server ??= createServer({
    content: {
      domain: CONTENT,
      scheme: "https",
      name: prefixedName("a-"),
      reserved: ["f", "www"],
    },
    secret: new TextEncoder().encode(env.SECRET),
    hostOrigins: [HOST],
    configs: {
      artifact: presets.artifact({
        isolation: "domain",
        contentOrigins: [`https://*.${CONTENT}`],
      }),
    },
    // A url-mode app (P101's checks on workerd): the app answers what it was asked.
    upstream: (request) =>
      new Response(`app: ${request.method} ${new URL(request.url).pathname}`, {
        headers: { "content-type": "text/plain" },
      }),
    artifacts: {
      get: async (id, version) =>
        id === "page"
          ? { html: `<!doctype html><html><body><h1 id="v">${version}</h1></body></html>` }
          : id === "site"
            ? site(version)
            : null,
    },
    tickets: d1TicketStore(env.DB),
    authorize: {
      check: ({ subject }) =>
        subject !== undefined && revoked.has(subject)
          ? { allow: false, code: "revoked" }
          : { allow: true },
    },
  });
  return server;
}

/** The host kit on Workers (P066): an app's whole wiring, its four policies and its settings. */
let hosted: ContentHost<{ readonly id: string }> | null = null;
function kit(env: Env) {
  hosted ??= createContentHost<{ readonly id: string }>({
    domain: "kitcontent.test",
    appOrigins: [HOST],
    secret: env.SECRET,
    tickets: d1TicketStore(env.DB),
    configs: (source) => ({
      artifact: presets.artifact({ isolation: "domain", contentOrigins: [source] }),
    }),
    name: prefixedName("a-"),
    reserved: ["f"],
    instance: (proposal) =>
      proposal.document.kind === "artifact" && /^[a-z0-9]+$/u.test(proposal.document.id)
        ? { scope: proposal.document.id, document: { kind: "artifact", id: "page", version: "1" } }
        : null,
    access: (_instance, viewer) =>
      viewer === null ? null : { viewer: viewer.id, subject: viewer.id },
    authorize: ({ subject }) =>
      subject !== undefined && revoked.has(subject)
        ? { allow: false, code: "revoked" }
        : { allow: true },
    source: (id, version) =>
      Promise.resolve(
        id === "page" ? { html: `<!doctype html><h1 id="v">kit ${version}</h1>` } : null,
      ),
    // Redirect entry (P068): every scope's / is its page's first version.
    entry: {
      authorizeUrl: `${HOST}/kit/authorize`,
      at: (scope, path) =>
        path === "/" ? { scope, document: { kind: "artifact", id: "page", version: "1" } } : null,
      signIn: (returnTo) =>
        new Response(null, {
          status: 303,
          headers: { location: `${HOST}/signin?next=${encodeURIComponent(returnTo)}` },
        }),
    },
  });
  return hosted;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const fromKit = await kit(env).fetch(request);
    if (fromKit !== null) {
      return fromKit;
    }
    if (url.origin === HOST && url.pathname === "/kit/authorize") {
      return kit(env).authorize((asked) => {
        const who = asked.headers.get("x-viewer");
        return who === null ? null : { id: who };
      })(request);
    }
    if (url.hostname === "host.test" && url.pathname === "/kit/issue") {
      return kit(env).issue((asked) => {
        const who = asked.headers.get("x-viewer");
        return who === null ? null : { id: who };
      })(request);
    }
    if (url.hostname === "host.test") {
      const id = url.searchParams.get("id") ?? "1";
      const instance = {
        scope: id,
        document: {
          kind: "artifact" as const,
          id: url.searchParams.get("doc") ?? "page",
          version: url.searchParams.get("v") ?? "1",
        },
      };
      if (url.pathname === "/issue") {
        const subject = url.searchParams.get("subject");
        const grant =
          url.searchParams.get("anonymous") === "1"
            ? { anonymous: true as const, ...(subject === null ? {} : { subject }) }
            : { viewer: "person-1", ...(subject === null ? {} : { subject }) };
        return Response.json(await porthole(env).issue(instance, grant));
      }
      if (url.pathname === "/issue-app") {
        return Response.json(
          await porthole(env).issue(
            { scope: id, document: { kind: "external", url: "http://127.0.0.1:5173/" } },
            { viewer: "person-1" },
          ),
        );
      }
      if (url.pathname === "/revoke") {
        revoked.add(url.searchParams.get("subject") ?? "");
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/runtime") {
        // What this runtime offers: the worker runs without Node's modules.
        return Response.json({
          buffer: typeof (globalThis as { Buffer?: unknown }).Buffer,
          process: typeof (globalThis as { process?: unknown }).process,
        });
      }
    }
    // A url-mode app's WebSocket, as a Worker takes it (P101): the host's own upgrade path, let in
    // by `access`; the app's socket here is a stand-in that accepts.
    if (
      request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
      url.hostname.endsWith(`.${CONTENT}`)
    ) {
      if ((await porthole(env).access(request)) === null) {
        return new Response(null, { status: 404 });
      }
      const pair = new WebSocketPair();
      pair[1].accept();
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    return (
      (await porthole(env).handle(request)) ??
      new Response("the host's own routes", { status: 404 })
    );
  },
};
