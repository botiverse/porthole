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
const HOST = "https://artifacts.example";

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
    artifacts: {
      get: async (id, version) =>
        id === "page"
          ? { html: `<!doctype html><html><body><h1 id="v">${version}</h1></body></html>` }
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
          id: "page",
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
    return (
      (await porthole(env).handle(request)) ??
      new Response("the host's own routes", { status: 404 })
    );
  },
};
