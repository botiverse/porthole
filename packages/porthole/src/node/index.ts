/**
 * `@botiverse/porthole/node`: the host kit on Node's own HTTP server (P066). Every request and
 * WebSocket whose Host is under the content domain is Porthole's; the app's reserved labels
 * (previews) and its own hosts go to the app's listeners.
 *
 *   const content = createContentHost({ …, health: { probe: nodeProbe() } });
 *   const porthole = nodeHost(content, { request: appListener, upgrade: appUpgrade });
 *   const server = http.createServer(porthole.request);
 *   server.on("upgrade", porthole.upgrade);
 *   server.listen(8080, () => content.start());
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import type { ContentHost, HealthProbe } from "../server/host.ts";
import type { Access } from "../server/types.ts";

type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;
type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface NodeHostOptions {
  /** The app's own request listener (Express, Hono's `getRequestListener`, a router). */
  readonly request: RequestListener;
  /** The app's own upgrade listener (its WebSockets, and its reserved labels' sockets). */
  readonly upgrade?: UpgradeListener;
  /** A url-mode app's WebSocket, once its cookie checks out (`ContentHost.access`). */
  readonly appSocket?: (
    access: Access,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
}

export interface NodeHost {
  readonly request: RequestListener;
  readonly upgrade: UpgradeListener;
}

/**
 * The Node request as a fetch `Request`: an absolute-form target kept as it came (P056). `signal`
 * (`nodeHost` gives one, aborted when the client goes away) lets an upstream stop its work.
 */
export function toRequest(
  request: IncomingMessage,
  scheme: "https" | "http",
  signal?: AbortSignal,
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    for (const each of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, each);
    }
  }
  const target = request.url ?? "/";
  const url = target.startsWith("/")
    ? `${scheme}://${request.headers.host ?? "localhost"}${target}`
    : target;
  const method = request.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD" ? null : (Readable.toWeb(request) as ReadableStream);
  return new Request(url, {
    method,
    headers,
    body,
    duplex: "half",
    ...(signal === undefined ? {} : { signal }),
  } as RequestInit);
}

/**
 * Writes a fetch `Response` to a Node response, cookies one header each (P070): it waits for the
 * socket to drain before reading on (a slow client never makes it buffer the body), cancels the
 * body when the client goes away (an event stream ends with the page that asked for it), and on
 * an error mid-body destroys the response rather than end it looking complete.
 */
export async function sendResponse(response: ServerResponse, answer: Response): Promise<void> {
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
  const reader = answer.body.getReader();
  let gone = false;
  const leave = () => {
    gone = true;
    reader.cancel().catch(() => undefined);
  };
  // The client went away before the end: stop reading, and let the body's source know.
  response.once("close", () => {
    if (!response.writableFinished) {
      leave();
    }
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || gone) {
        break;
      }
      if (!response.write(value)) {
        await new Promise<void>((resolve) => {
          const on = () => {
            response.off("drain", on);
            response.off("close", on);
            resolve();
          };
          response.on("drain", on);
          response.on("close", on);
        });
      }
    }
  } catch (error) {
    // The head is sent: a body cut short must not look whole.
    leave();
    response.destroy(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  if (!gone) {
    response.end();
  }
}

/** Whether a Node request's Host (or absolute-form target) is under the content domain. */
function forContent<V>(content: ContentHost<V>, request: IncomingMessage): boolean {
  const domain = content.domain;
  if (domain === null) {
    return false;
  }
  const host = request.headers.host ?? "";
  let target = "";
  try {
    target = (request.url ?? "/").startsWith("/") ? "" : new URL(request.url ?? "").hostname;
  } catch {
    target = "";
  }
  return domain.isContentHost(host) || (target !== "" && domain.isContentHost(target));
}

/** Refuses a WebSocket on the content domain with a plain 404, and closes it. */
function refuseSocket(socket: Duplex): void {
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

export function nodeHost<V>(content: ContentHost<V>, app: NodeHostOptions): NodeHost {
  const scheme = () => content.domain?.scheme ?? "http";
  return {
    request(request, response) {
      if (!forContent(content, request)) {
        app.request(request, response);
        return;
      }
      // Aborted when the client goes away first, so an upstream (a proxied app's event stream)
      // stops with it.
      const gone = new AbortController();
      response.once("close", () => {
        if (!response.writableFinished) {
          gone.abort();
        }
      });
      content.fetch(toRequest(request, scheme(), gone.signal)).then(
        (answer) => {
          if (answer === null) {
            // A label the app routes itself.
            app.request(request, response);
            return;
          }
          return sendResponse(response, answer);
        },
        () => {
          if (response.headersSent) {
            response.destroy();
            return;
          }
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end("Content couldn't be served.");
        },
      );
    },
    upgrade(request, socket, head) {
      if (!forContent(content, request)) {
        if (app.upgrade === undefined) {
          refuseSocket(socket);
        } else {
          app.upgrade(request, socket, head);
        }
        return;
      }
      const asked = toRequest(request, scheme());
      // A reserved label's socket is the app's.
      if (!content.owns(asked)) {
        if (app.upgrade === undefined) {
          refuseSocket(socket);
        } else {
          app.upgrade(request, socket, head);
        }
        return;
      }
      const appSocket = app.appSocket;
      if (appSocket === undefined) {
        refuseSocket(socket);
        return;
      }
      content.access(asked).then(
        (access) => {
          if (access === null) {
            refuseSocket(socket);
          } else {
            appSocket(access, request, socket, head);
          }
        },
        () => refuseSocket(socket),
      );
    },
  };
}

/** Resolves every `*.localhost` name to loopback, as browsers do (Node's resolver may not). */
const loopbackLookup: LookupFunction = (hostname, options, callback) => {
  const all = typeof options === "object" && options !== null && options.all === true;
  if (all) {
    (
      callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void
    )(null, [{ address: "127.0.0.1", family: 4 }]);
    return;
  }
  callback(null, "127.0.0.1", 4);
};

/**
 * The health gate's probe on Node: a GET over the real network (DNS, the edge, TLS with Node's
 * own certificate checks), `*.localhost` resolved to loopback, redirects not followed, at most 4 KB
 * of the answer read.
 */
export function nodeProbe(): HealthProbe {
  return (url, timeoutMs) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const local = target.hostname === "localhost" || target.hostname.endsWith(".localhost");
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      const asked = send(
        target,
        {
          method: "GET",
          headers: { accept: "application/json" },
          timeout: timeoutMs,
          ...(local ? { lookup: loopbackLookup } : {}),
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            if (body.length < 4_096) {
              body += chunk;
            }
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body: body.slice(0, 4_096) }),
          );
          response.on("error", reject);
        },
      );
      asked.on("timeout", () => asked.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
      asked.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          new Error(error.code === undefined ? error.message : `${error.code} ${error.message}`),
        ),
      );
      asked.end();
    });
}
