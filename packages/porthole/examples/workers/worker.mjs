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
import { d1TicketStore } from "@botiverse/porthole/server";
import { makeApp } from "../app.mjs";

let app = null; // one per isolate, made from the first request's env

export default {
  async fetch(request, env) {
    app ??= makeApp({
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
    // The content domain first (Porthole answers every request there), then the app.
    return (await app.content.fetch(request)) ?? app.handle(request);
  },
};
