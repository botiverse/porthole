// The example app on Cloudflare Workers: tickets in D1, Porthole's browser modules as static
// assets. No nodejs_compat needed.
//
//   npx porthole d1-schema > migrations/0001_porthole_tickets.sql   (already here)
//   echo "PORTHOLE_SECRET=$(npx porthole secret)" > .dev.vars
//   npx wrangler d1 migrations apply porthole-example --local && npx wrangler dev --port 8793
//   open http://localhost:8793   (content: http://*.content.localhost:8793)
//
// wrangler.jsonc sets `run_worker_first`: every request, the content domain's included, comes
// here first, so static assets are never answered on a content origin.
import { contentHostFor, d1TicketStore } from "@botiverse/porthole/server";
import { makeApp } from "../app.mjs";

/** The app for a Worker's settings (its `env`): made once per settings object. */
const apps = new WeakMap();
const appOf = (env) => {
  let app = apps.get(env);
  if (app === undefined) {
    app = makeApp({
      appOrigin: env.APP_ORIGIN,
      contentDomain: env.CONTENT_DOMAIN,
      secret: env.PORTHOLE_SECRET,
      tickets: d1TicketStore(env.DB),
      conformance: env.PORTHOLE_CONFORMANCE === "1",
      // Porthole's browser modules, from the assets directory (the package's dist/).
      client: async (path) => {
        const answer = await env.ASSETS.fetch(new URL(path, env.APP_ORIGIN));
        return answer.ok ? answer : null;
      },
    });
    apps.set(env, app);
  }
  return app;
};

// One content host per `env`. Settings that can't be served (no PORTHOLE_SECRET, a content
// domain that shares a site with the app) answer every request with a 503 naming the problem.
const porthole = contentHostFor((env) => appOf(env).options, { log: console.error });

export default {
  async fetch(request, env) {
    // The content domain first (Porthole answers every request there), then the app.
    return (await porthole.fetch(request, env)) ?? appOf(env).handle(request, porthole.host(env));
  },
};
