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
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer, request as httpRequest, STATUS_CODES } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import type { ContentHost, HealthProbe } from "../server/host.ts";
import { withoutPortholeCookies } from "../server/proxy.ts";
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
 * Throws where fetch can't take the request: a method it can't carry (`TRACE`), a Host or a
 * target that is no URL. `nodeListener`, `nodeHost` and `nodeServer` answer those 405 and 400.
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
 * Whether an answer goes out before its request came in whole (a refusal of a body too big, a
 * request fetch can't take): its connection then closes once the answer is out, never left
 * waiting on a body no one reads (S06, P092).
 */
const unread = (response: ServerResponse): boolean =>
  (response.req as IncomingMessage | undefined)?.complete === false;

/**
 * Writes a fetch `Response` to a Node response, cookies one header each (P070): it waits for the
 * socket to drain before reading on (a slow client never makes it buffer the body), cancels the
 * body when the client goes away (an event stream ends with the page that asked for it), and on
 * an error mid-body destroys the response rather than end it looking complete. A head Node can't
 * write (a header value fetch takes and Node doesn't) is a 500 (S01, P092): it never rejects. An
 * answer before the request's body came in whole closes the connection after it.
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
  if (unread(response)) {
    headers.connection = "close";
  }
  try {
    response.writeHead(answer.status, headers);
  } catch {
    answer.body?.cancel().catch(() => undefined);
    answerPlain(response, 500, "The answer couldn't be written.");
    return;
  }
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

/** The methods a fetch `Request` can't carry (the Fetch standard's forbidden methods). */
const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

/**
 * `toRequest`, or the status for a request fetch can't take (S01, P092): 405 for a method it
 * can't carry, 400 for anything else (a Host or a target that is no URL). Never throws: the
 * conversion runs in a listener, where a throw would end the process.
 */
function convert(
  request: IncomingMessage,
  scheme: "https" | "http",
  signal?: AbortSignal,
): Request | 400 | 405 {
  try {
    return toRequest(request, scheme, signal);
  } catch {
    return FORBIDDEN_METHODS.has((request.method ?? "").toUpperCase()) ? 405 : 400;
  }
}

/**
 * A plain answer of the adapter's own. A response already started is cut off, never made to look
 * whole; one already ended is left be. Never throws: it answers from the listeners' catches.
 */
function answerPlain(response: ServerResponse, status: number, text: string): void {
  try {
    if (response.writableEnded) {
      return;
    }
    if (response.headersSent) {
      response.destroy();
      return;
    }
    // The reason given: a head Node refused to write leaves its own behind.
    response.writeHead(status, STATUS_CODES[status], {
      "content-type": "text/plain; charset=utf-8",
      ...(unread(response) ? { connection: "close" } : {}),
    });
    response.end(text);
  } catch {
    response.destroy();
  }
}

const REFUSED: Record<400 | 405, string> = {
  400: "Bad request.",
  405: "That method isn't served here.",
};

/**
 * Writes what a fetch-style handler answers (null: `otherwise`, the app's own listener). Whatever
 * fails, the handler (thrown or rejected), `otherwise`, or the writing (a header fetch takes and
 * Node doesn't), answers 500, or cuts off a response already started: nothing escapes (S01, P092).
 */
function serve(
  response: ServerResponse,
  handle: () => Response | null | Promise<Response | null>,
  failed: string,
  otherwise?: () => void,
): void {
  new Promise<Response | null>((resolve) => resolve(handle()))
    .then((answer) => {
      if (answer === null && otherwise !== undefined) {
        otherwise();
        return undefined;
      }
      // Anything that isn't a Response (an app's null or undefined) fails here, as a 500.
      return sendResponse(response, answer as Response);
    })
    .catch(() => answerPlain(response, 500, failed));
}

/**
 * A fetch-style handler (Hono's `app.fetch`, the app's own) as a Node request listener: what
 * `toRequest` can't convert is 405 or 400, what the handler throws or the answer's writing fails
 * is 500; nothing it does ends the process (S01, P092). `scheme` is the requests' URLs' (default
 * `http`; `https` behind a TLS edge, as `nodeServer`'s).
 */
export function nodeListener(
  app: (request: Request) => Response | Promise<Response>,
  options: { readonly scheme?: "https" | "http" } = {},
): RequestListener {
  const scheme = options.scheme ?? "http";
  return (incoming, response) => {
    const asked = convert(incoming, scheme);
    if (typeof asked === "number") {
      answerPlain(response, asked, REFUSED[asked]);
      return;
    }
    serve(response, () => app(asked), "Something went wrong.");
  };
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

/** Refuses a WebSocket with a plain status (404: on the content domain), and closes it. */
function refuseSocket(socket: Duplex, status = 404): void {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export function nodeHost<V>(content: ContentHost<V>, app: NodeHostOptions): NodeHost {
  const scheme = () => content.domain?.scheme ?? "http";
  // Nothing in either listener throws out of it, the app's own listeners included (S01, P092):
  // a request ends in an answer, a socket in a refusal or closed.
  return {
    request(request, response) {
      try {
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
        const asked = convert(request, scheme(), gone.signal);
        if (typeof asked === "number") {
          answerPlain(response, asked, REFUSED[asked]);
          return;
        }
        // Null: a label the app routes itself.
        serve(
          response,
          () => content.fetch(asked),
          "Content couldn't be served.",
          () => app.request(request, response),
        );
      } catch {
        answerPlain(response, 500, "Something went wrong.");
      }
    },
    upgrade(request, socket, head) {
      try {
        if (!forContent(content, request)) {
          if (app.upgrade === undefined) {
            refuseSocket(socket);
          } else {
            app.upgrade(request, socket, head);
          }
          return;
        }
        const asked = convert(request, scheme());
        if (typeof asked === "number") {
          refuseSocket(socket, asked);
          return;
        }
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
        content
          .access(asked)
          .then(
            (access) => {
              if (access === null) {
                refuseSocket(socket);
              } else {
                // The app's socket never sees Porthole's own cookies, as its HTTP requests don't
                // (P072).
                const cookie = withoutPortholeCookies(request.headers.cookie);
                if (cookie === null) {
                  delete request.headers.cookie;
                } else {
                  request.headers.cookie = cookie;
                }
                appSocket(access, request, socket, head);
              }
            },
            () => refuseSocket(socket),
          )
          .catch(() => socket.destroy());
      } catch {
        socket.destroy();
      }
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

export interface NodeServerOptions {
  /**
   * The content host, or a function giving it when it exists: a host made after the server listens
   * (its content domain names the port `listen(0)` chose, P074). Until it gives one, every request
   * is the app's. `nodeServer` starts the host's health gate when it listens, asking the function
   * once the server's `listen` callbacks have run (a host made in one starts then), and again at
   * each request until it gives one; `start` is idempotent, so an app may start the host itself
   * as soon as it makes it (P076).
   */
  readonly content: ContentHost<unknown> | (() => ContentHost<unknown> | null);
  /**
   * The app, fetch-style (Hono's `app.fetch`, or the app's own handler): every request that
   * isn't the content domain's. Or `request`, a Node listener (Express).
   */
  readonly app?: (request: Request) => Response | Promise<Response>;
  readonly request?: RequestListener;
  readonly upgrade?: UpgradeListener;
  readonly appSocket?: NodeHostOptions["appSocket"];
  /** Whether the app's own requests came over https (behind a TLS edge): their URL's scheme. */
  readonly scheme?: "https" | "http";
}

/**
 * The whole Node server (P072): the content domain to Porthole, everything else to the app, its
 * WebSockets included; the health gate started when it listens and stopped when it closes.
 *
 *   nodeServer({ content, app: (request) => app.fetch(request) }).listen(8790);
 */
export function nodeServer(options: NodeServerOptions): Server {
  const scheme = options.scheme ?? "http";
  const request: RequestListener | undefined =
    options.request ??
    (options.app === undefined ? undefined : nodeListener(options.app, { scheme }));
  if (request === undefined) {
    throw new TypeError("nodeServer needs the app: app (fetch-style) or request (a Node listener)");
  }
  const adapters = new WeakMap<ContentHost<unknown>, NodeHost>();
  const started = new WeakSet<ContentHost<unknown>>();
  let listening = false;
  const given = options.content;
  /** The host now (made once, adapted once), started once the server listens. */
  const current = (): NodeHost | null => {
    const host = typeof given === "function" ? given() : given;
    if (host === null) {
      return null;
    }
    let adapter = adapters.get(host);
    if (adapter === undefined) {
      adapter = nodeHost(host, {
        request,
        ...(options.upgrade === undefined ? {} : { upgrade: options.upgrade }),
        ...(options.appSocket === undefined ? {} : { appSocket: options.appSocket }),
      });
      adapters.set(host, adapter);
    }
    if (listening && !started.has(host)) {
      started.add(host);
      host.start();
    }
    return adapter;
  };
  // The host function, the app's listeners: nothing throws out of the server's events (S01).
  const server = createHttpServer((incoming, response) => {
    try {
      const adapter = current();
      if (adapter === null) {
        request(incoming, response);
      } else {
        adapter.request(incoming, response);
      }
    } catch {
      answerPlain(response, 500, "Something went wrong.");
    }
  });
  server.on("upgrade", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const adapter = current();
      if (adapter !== null) {
        adapter.upgrade(incoming, socket, head);
      } else if (options.upgrade !== undefined) {
        options.upgrade(incoming, socket, head);
      } else {
        refuseSocket(socket);
      }
    } catch {
      socket.destroy();
    }
  });
  server.on("listening", () => {
    listening = true;
    // After the listen callbacks: a host made in one (with the port it got) starts now.
    setImmediate(current);
  });
  server.on("close", () => {
    listening = false;
    const host = typeof given === "function" ? given() : given;
    host?.close();
  });
  return server;
}
