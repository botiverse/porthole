/**
 * The Node adapter's servers in a process of their own, as an app runs them (test/node.test.ts,
 * P092): Node's default for an uncaught exception or an unhandled rejection ends this process,
 * which the test sees. Says its ports, and what happens, as JSON lines on stdout.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { presets } from "../../src/index.ts";
import { nodeHost, nodeServer } from "../../src/node/index.ts";
import { createContentHost, prefixedName } from "../../src/server/index.ts";

const say = (...event: unknown[]) => process.stdout.write(`${JSON.stringify(event)}\n`);
const onError = (error: unknown) => say("error", error instanceof Error ? error.message : error);

const content = createContentHost({
  domain: "content.localhost",
  appOrigins: ["http://localhost:5173"],
  secret: "a test secret that is at least thirty-two bytes long",
  configs: (source) => ({
    artifact: presets.artifact({ isolation: "domain", contentOrigins: [source] }),
  }),
  name: prefixedName("a-"),
  reserved: ["p-*"],
  instance: () => null,
  access: () => null,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The app, fetch-style. */
const app = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname;
  if (path === "/throws") {
    throw new Error("the app broke");
  }
  if (path === "/rejects") {
    await wait(1);
    throw new Error("the app broke later");
  }
  if (path === "/unwritable") {
    // A header fetch takes and Node can't write.
    return new Response("x", { headers: { "x-said": "a\u0001b" } });
  }
  if (path === "/locked") {
    const answer = new Response("x");
    answer.body?.getReader();
    return answer;
  }
  if (path === "/not-a-response") {
    return {} as Response;
  }
  if (path === "/endless") {
    // Made as fast as it is read: a writer that never waits never yields.
    let pulled = 0;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(1_024));
          },
          cancel() {
            say("endless-cancelled", pulled);
          },
        },
        { highWaterMark: 0 },
      ),
    );
  }
  if (path === "/slow") {
    request.signal.addEventListener("abort", () => say("slow-aborted"));
    await wait(300);
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            say("slow-pulled");
            controller.enqueue(new Uint8Array(1_024));
            await wait(50);
          },
          cancel() {
            say("slow-cancelled");
          },
        },
        { highWaterMark: 0 },
      ),
    );
  }
  return new Response("the app");
};

/** The app's own Node listener. */
const listener = (request: IncomingMessage, response: ServerResponse): unknown => {
  if (request.url === "/throws") {
    throw new Error("the app's listener broke");
  }
  if (request.url === "/async-rejects") {
    return (async () => {
      await wait(1);
      throw new Error("the app's async listener broke");
    })();
  }
  response.end("own");
  return undefined;
};

const whole = nodeServer({
  content,
  app,
  onError,
  // A url-mode app's socket, once its cookie checks out: the access asked first (async).
  appSocket: (_access, _request, socket) => socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
});
const host = nodeHost(content, { request: listener, onError });
const own = createServer(host.request);
own.on("upgrade", host.upgrade);

const port = (server: { address(): unknown }) => (server.address() as AddressInfo).port;
whole.listen(0, "127.0.0.1", () =>
  own.listen(0, "127.0.0.1", () => say("ports", { whole: port(whole), own: port(own) })),
);
