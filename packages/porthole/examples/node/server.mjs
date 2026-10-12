// The example app on Node: `nodeServer` sends the content domain to Porthole and everything else
// to the app, WebSockets included, and runs the health gate while it listens.
//
//   PORTHOLE_SECRET=$(npx porthole secret) node node_modules/@botiverse/porthole/examples/node/server.mjs
//   open http://localhost:8790   (content is served on http://*.content.localhost:8790, the same server)
//
// Locally the app is http://localhost:<port> and content http://*.content.localhost:<port>: every
// *.localhost name is loopback in browsers, and each is a site of its own, so they never share
// cookies or storage. In production: https://app.example.com and content.example-usercontent.com.
//
// An app that keeps its own node:http server (or Express, Fastify) uses `nodeHost(content, { request })`
// instead: its `request` and `upgrade` listeners, with `content.start()` once listening.
import { readFile } from "node:fs/promises";
import { createContentHost, memoryTicketStore } from "@botiverse/porthole/server";
import { nodeProbe, nodeServer } from "@botiverse/porthole/node";
import { makeApp } from "../app.mjs";

/** Porthole's browser modules (the package's dist/), served to the app's page. */
const dist = new URL("../dist/", import.meta.resolve("@botiverse/porthole"));

export function start({
  port = 8790,
  secret = process.env.PORTHOLE_SECRET,
  conformance = process.env.PORTHOLE_CONFORMANCE === "1",
} = {}) {
  // Under the health gate, createContentHost takes a missing secret as a lasting misconfiguration
  // (frames opaque, the log says why); an example says so at once.
  if (!secret) throw new Error("Set PORTHOLE_SECRET (npx porthole secret makes one)");
  const appOrigin = `http://localhost:${port}`;
  const app = makeApp({
    appOrigin,
    contentDomain: `content.localhost:${port}`,
    secret,
    tickets: memoryTicketStore(),
    // The opaque fallback: frames are served once the content domain answers over the network.
    health: { probe: nodeProbe() },
    conformance,
    client: async (path) => {
      if (!/^\/[\w/.-]+\.js$/u.test(path) || path.includes("..")) return null;
      return readFile(new URL(`.${path}`, dist)).then(
        (body) =>
          new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8" } }),
        () => null,
      );
    },
  });
  const content = createContentHost(app.options);
  const server = nodeServer({ content, app: (request) => app.handle(request, content) });
  return new Promise((resolve) =>
    server.listen(port, () => resolve({ server, content, appOrigin, close: () => server.close() })),
  );
}

if (import.meta.main) {
  const { appOrigin } = await start({ port: Number(process.env.PORT ?? 8790) });
  console.log(`The app: ${appOrigin}`);
}
