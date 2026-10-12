// The example app on Node: node:http, with Porthole's Node adapter in front of it.
//
//   PORTHOLE_SECRET=$(npx porthole secret) node node_modules/@botiverse/porthole/examples/node/server.mjs
//   open http://localhost:8790   (content is served on http://*.content.localhost:8790, the same server)
//
// Locally the app is http://localhost:<port> and content http://*.content.localhost:<port>: every
// *.localhost name is loopback in browsers, and each is a site of its own, so they never share
// cookies or storage. In production: https://app.example.com and content.example-usercontent.com.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { memoryTicketStore } from "@botiverse/porthole/server";
import { nodeHost, nodeProbe, sendResponse, toRequest } from "@botiverse/porthole/node";
import { makeApp } from "../app.mjs";

/** Porthole's browser modules (the package's dist/), served to the app's page. */
const dist = new URL("../dist/", import.meta.resolve("@botiverse/porthole"));
const TYPES = { ".js": "text/javascript; charset=utf-8" };

export function start({
  port = 8790,
  secret = process.env.PORTHOLE_SECRET,
  conformance = process.env.PORTHOLE_CONFORMANCE === "1",
} = {}) {
  if (!secret) throw new Error("Set PORTHOLE_SECRET (npx porthole secret)");
  const appOrigin = `http://localhost:${port}`;
  const { content, handle } = makeApp({
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
        (body) => new Response(body, { headers: { "content-type": TYPES[".js"] } }),
        () => null,
      );
    },
  });
  // Content hosts go to Porthole; everything else to the app.
  const porthole = nodeHost(content, {
    request: (request, response) => {
      handle(toRequest(request, "http")).then(
        (answer) => sendResponse(response, answer),
        (error) => {
          console.error(error);
          response.writeHead(500).end();
        },
      );
    },
  });
  const server = createServer(porthole.request);
  server.on("upgrade", porthole.upgrade);
  return new Promise((resolve) =>
    server.listen(port, () => {
      content.start();
      resolve({
        server,
        content,
        appOrigin,
        close: () => {
          content.close();
          server.close();
        },
      });
    }),
  );
}

if (import.meta.main) {
  const { appOrigin } = await start({ port: Number(process.env.PORT ?? 8790) });
  console.log(`The app: ${appOrigin}`);
}
