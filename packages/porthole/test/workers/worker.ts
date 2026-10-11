import { presets } from "../../src/index.ts";
import { createServer, d1TicketStore, prefixedName, type D1Like } from "../../src/server/index.ts";

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
