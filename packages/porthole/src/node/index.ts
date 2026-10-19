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
 *
 * Nothing a request does throws out of these listeners or ends the process (S01, P092): what fetch
 * can't take is 405 or 400; what fails on the app's side (a handler, a listener, an answer Node
 * can't write) is 500, and `onError` hears it.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer, request as httpRequest, STATUS_CODES } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { Duplex } from "node:stream";
import type { ContentHost, HealthProbe } from "../server/host.ts";
import { withPeerAddress } from "../server/peer.ts";
import { withoutPortholeCookies } from "../server/proxy.ts";
import type { Access } from "../server/types.ts";

type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;
type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Hears what failed on the app's side while serving a request (its handler or listener threw or
 * rejected, an answer Node can't write), once the client has its 500. Default: a process warning
 * (`process.emitWarning`). Never the client's to read.
 */
export type NodeErrorListener = (error: unknown, request: IncomingMessage) => void;

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
  readonly onError?: NodeErrorListener;
}

export interface NodeHost {
  readonly request: RequestListener;
  readonly upgrade: UpgradeListener;
}

/** Tells the app what failed (`onError`, or a process warning); a report never fails a request. */
function report(onError: NodeErrorListener | undefined, error: unknown, request: IncomingMessage) {
  try {
    if (onError === undefined) {
      process.emitWarning(error instanceof Error ? error : new Error(String(error)));
    } else {
      onError(error, request);
    }
  } catch {
    // The report's own failure is not the request's.
  }
}

/** The most of a body no one reads that is dropped before the connection closes (P092). */
const DROP_BYTES = 1_048_576;
/** How long an answered request's unread body is dropped before the connection closes (P092). */
const DROP_MS = 5_000;
const dropping = new WeakSet<IncomingMessage>();

/**
 * Reads and drops what is left of a request's body no one will read, at most `DROP_BYTES`, then
 * closes the connection (P092). A client still sending its body gets the answer this way: closed
 * at once with the body unread, the connection is reset, and the answer with it.
 */
function drop(request: IncomingMessage): void {
  if (request.complete || dropping.has(request)) {
    return;
  }
  dropping.add(request);
  let dropped = 0;
  const count = (chunk: Buffer) => {
    dropped += chunk.byteLength;
    if (dropped > DROP_BYTES) {
      request.off("data", count);
      request.socket.destroy();
    }
  };
  request.on("data", count);
  request.resume();
}

/**
 * Once an answer is out, what its request's body still holds is dropped for at most `DROP_MS`
 * (and `DROP_BYTES`), then the connection closes: never left waiting on a body no one reads, and
 * a body dropped whole leaves the connection to go on (P092).
 */
function dropAfter(response: ServerResponse): void {
  response.once("finish", () => {
    const request = (response.req as IncomingMessage | undefined) ?? null;
    if (request === null || request.complete) {
      return;
    }
    drop(request);
    const socket = request.socket;
    const timer = setTimeout(() => socket.destroy(), DROP_MS);
    timer.unref();
    const stop = () => clearTimeout(timer);
    request.once("end", stop);
    socket.once("close", stop);
  });
}

/**
 * A Node request's body as a stream, read only as it is pulled (a body no one reads is never
 * taken: the app's listener gets it whole, P092). Cancelled, the rest is dropped (`drop`), not
 * the connection: the answer still goes out.
 */
function bodyOf(request: IncomingMessage): ReadableStream<Uint8Array> {
  let listening = false;
  let settled = false;
  let stop = () => {};
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (settled) {
          return;
        }
        if (!listening) {
          listening = true;
          const settle = () => {
            settled = true;
            stop();
          };
          const data = (chunk: Buffer) => {
            if (!settled) {
              controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
              request.pause();
            }
          };
          const end = () => {
            if (!settled) {
              settle();
              controller.close();
            }
          };
          const fail = () => {
            if (!settled) {
              settle();
              controller.error(new Error("The request's body broke off"));
            }
          };
          const close = () => {
            if (!request.complete) {
              fail();
            }
          };
          request.on("data", data);
          request.on("end", end);
          request.on("error", fail);
          request.on("close", close);
          stop = () => {
            request.off("data", data);
            request.off("end", end);
            request.off("error", fail);
            request.off("close", close);
          };
        }
        request.resume();
      },
      cancel() {
        settled = true;
        stop();
        drop(request);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * The Node request as a fetch `Request`: an absolute-form target kept as it came (P056). `signal`
 * (`nodeHost` gives one, aborted when the client goes away) lets an upstream stop its work. The
 * body is read only as it is pulled; cancelled, the rest is dropped (bounded), not the connection.
 * The socket's peer goes with it, for the issue endpoint's rate limit (P092).
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
  const body = method === "GET" || method === "HEAD" ? null : bodyOf(request);
  return withPeerAddress(
    new Request(url, {
      method,
      headers,
      body,
      duplex: "half",
      ...(signal === undefined ? {} : { signal }),
    } as RequestInit),
    request.socket.remoteAddress,
  );
}

/** A fetch Response's head for Node, cookies one header each (P070). Throws for no Response. */
function headOf(answer: Response): Record<string, string | string[]> {
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
  if (answer.bodyUsed || answer.body?.locked === true) {
    throw new TypeError("The answer's body is already being read");
  }
  return headers;
}

/**
 * Writes a fetch `Response` to a Node response, cookies one header each (P070): it waits for the
 * socket to drain before reading on (a slow client never makes it buffer the body), cancels the
 * body when the client goes away, before the answer or during it (an event stream ends with the
 * page that asked for it), and on an error mid-body destroys the response rather than end it
 * looking complete. A HEAD gets the head and its body is cancelled. Never rejects (P092): an
 * answer it can't write (no Response, a body already read, a header value fetch takes and Node
 * doesn't) is a 500, and `onError` hears why. Once the answer is out, a request body no one read
 * is dropped, bounded, before the connection closes.
 */
export async function sendResponse(
  response: ServerResponse,
  answer: Response,
  onError?: (error: unknown) => void,
): Promise<void> {
  const cancel = () => {
    try {
      answer.body?.cancel().catch(() => undefined);
    } catch {
      // No Response, or a body already taken: nothing of it to stop.
    }
  };
  // The client went away before the answer: nothing to write, and the body's source is told.
  if (response.destroyed) {
    cancel();
    return;
  }
  try {
    const headers = headOf(answer);
    dropAfter(response);
    response.writeHead(answer.status, headers);
  } catch (error) {
    cancel();
    onError?.(error);
    answerPlain(response, 500, "The answer couldn't be written.");
    return;
  }
  const request = (response.req as IncomingMessage | undefined) ?? null;
  if (answer.body === null || request?.method === "HEAD") {
    // Node writes no body for HEAD: the head goes out with the end, and the body is never read.
    cancel();
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
      if (done || gone || response.destroyed) {
        break;
      }
      if (!response.write(value) && !response.destroyed) {
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
  if (response.destroyed) {
    leave();
  } else if (!gone) {
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
    if (response.writableEnded || response.destroyed) {
      return;
    }
    if (response.headersSent) {
      response.destroy();
      return;
    }
    dropAfter(response);
    // The reason given: a head Node refused to write leaves its own behind.
    response.writeHead(status, STATUS_CODES[status], {
      "content-type": "text/plain; charset=utf-8",
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

/** A request's signal: aborted when the client goes away before the answer is out (P070). */
function goneSignal(response: ServerResponse): AbortSignal {
  const gone = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) {
      gone.abort();
    }
  });
  return gone.signal;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

/**
 * Calls one of the app's own listeners: what it throws, or an async one's rejection, is reported
 * and ends in `failed` (a 500, a closed socket), never out of the listener (S01, P092).
 */
function callApp(
  call: () => unknown,
  failed: () => void,
  onError: NodeErrorListener | undefined,
  request: IncomingMessage,
): void {
  const fail = (error: unknown) => {
    report(onError, error, request);
    failed();
  };
  try {
    const returned = call();
    if (isThenable(returned)) {
      returned.then(undefined, fail);
    }
  } catch (error) {
    fail(error);
  }
}

/**
 * Writes what a fetch-style handler answers (null: `otherwise`, the app's own listener). Whatever
 * fails, the handler (thrown or rejected), `otherwise`, or the writing (a header fetch takes and
 * Node doesn't), answers 500, or cuts off a response already started, and is reported: nothing
 * escapes (S01, P092).
 */
function serve(
  request: IncomingMessage,
  response: ServerResponse,
  handle: () => Response | null | Promise<Response | null>,
  failed: string,
  onError: NodeErrorListener | undefined,
  otherwise?: () => void,
): void {
  const fail = (error: unknown) => {
    report(onError, error, request);
    answerPlain(response, 500, failed);
  };
  new Promise<Response | null>((resolve) => resolve(handle()))
    .then((answer) => {
      if (answer === null && otherwise !== undefined) {
        otherwise();
        return undefined;
      }
      // Anything that isn't a Response (an app's null or undefined) fails in it, as a 500.
      return sendResponse(response, answer as Response, (error) => report(onError, error, request));
    })
    .catch(fail);
}

export interface NodeListenerOptions {
  /** The requests' URLs' scheme (default `http`; `https` behind a TLS edge). */
  readonly scheme?: "https" | "http";
  readonly onError?: NodeErrorListener;
}

/**
 * A fetch-style handler (Hono's `app.fetch`, the app's own) as a Node request listener: what
 * `toRequest` can't convert is 405 or 400, what the handler throws or the answer's writing fails
 * is 500 (`onError` hears it); nothing it does ends the process (S01, P092). The request's
 * `signal` aborts when the client goes away before the answer is out.
 */
export function nodeListener(
  app: (request: Request) => Response | Promise<Response>,
  options: NodeListenerOptions = {},
): RequestListener {
  const scheme = options.scheme ?? "http";
  return (incoming, response) => {
    const asked = convert(incoming, scheme, goneSignal(response));
    if (typeof asked === "number") {
      answerPlain(response, asked, REFUSED[asked]);
      return;
    }
    serve(incoming, response, () => app(asked), "Something went wrong.", options.onError);
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

const guarded = new WeakSet<Duplex>();

/**
 * Node takes its own error listener off an upgrade's socket before the `upgrade` event: a reset
 * there would be an unhandled `error` and end the process (P092). The socket is closed instead.
 */
function guardSocket(socket: Duplex): void {
  if (!guarded.has(socket)) {
    guarded.add(socket);
    socket.on("error", () => socket.destroy());
  }
}

export function nodeHost<V>(content: ContentHost<V>, app: NodeHostOptions): NodeHost {
  const scheme = () => content.domain?.scheme ?? "http";
  const toApp = (request: IncomingMessage, response: ServerResponse) =>
    callApp(
      () => app.request(request, response),
      () => answerPlain(response, 500, "Something went wrong."),
      app.onError,
      request,
    );
  const toAppSocket = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const upgrade = app.upgrade;
    if (upgrade === undefined) {
      refuseSocket(socket);
      return;
    }
    callApp(
      () => upgrade(request, socket, head),
      () => socket.destroy(),
      app.onError,
      request,
    );
  };
  // Nothing in either listener throws out of it, the app's own listeners included (S01, P092):
  // a request ends in an answer, a socket in a refusal or closed.
  return {
    request(request, response) {
      try {
        if (!forContent(content, request)) {
          toApp(request, response);
          return;
        }
        // Aborted when the client goes away first, so an upstream (a proxied app's event stream)
        // stops with it.
        const asked = convert(request, scheme(), goneSignal(response));
        if (typeof asked === "number") {
          answerPlain(response, asked, REFUSED[asked]);
          return;
        }
        // A label the app routes itself: its request untouched, body and all (P092).
        if (!content.owns(asked)) {
          toApp(request, response);
          return;
        }
        serve(
          request,
          response,
          () => content.fetch(asked),
          "Content couldn't be served.",
          app.onError,
          () => toApp(request, response),
        );
      } catch (error) {
        report(app.onError, error, request);
        answerPlain(response, 500, "Something went wrong.");
      }
    },
    upgrade(request, socket, head) {
      guardSocket(socket);
      try {
        if (!forContent(content, request)) {
          toAppSocket(request, socket, head);
          return;
        }
        const asked = convert(request, scheme());
        if (typeof asked === "number") {
          refuseSocket(socket, asked);
          return;
        }
        // A reserved label's socket is the app's.
        if (!content.owns(asked)) {
          toAppSocket(request, socket, head);
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
              return;
            }
            // The app's socket never sees Porthole's own cookies, as its HTTP requests don't
            // (P072).
            const cookie = withoutPortholeCookies(request.headers.cookie);
            if (cookie === null) {
              delete request.headers.cookie;
            } else {
              request.headers.cookie = cookie;
            }
            callApp(
              () => appSocket(access, request, socket, head),
              () => socket.destroy(),
              app.onError,
              request,
            );
          },
          (error: unknown) => {
            report(app.onError, error, request);
            refuseSocket(socket);
          },
        );
      } catch (error) {
        report(app.onError, error, request);
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
  readonly onError?: NodeErrorListener;
}

/**
 * The whole Node server (P072): the content domain to Porthole, everything else to the app, its
 * WebSockets included; the health gate started when it listens and stopped when it closes.
 *
 *   nodeServer({ content, app: (request) => app.fetch(request) }).listen(8790);
 */
export function nodeServer(options: NodeServerOptions): Server {
  const scheme = options.scheme ?? "http";
  const onError = options.onError;
  const request: RequestListener | undefined =
    options.request ??
    (options.app === undefined
      ? undefined
      : nodeListener(options.app, { scheme, ...(onError === undefined ? {} : { onError }) }));
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
        ...(onError === undefined ? {} : { onError }),
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
    callApp(
      () => {
        const adapter = current();
        return adapter === null ? request(incoming, response) : adapter.request(incoming, response);
      },
      () => answerPlain(response, 500, "Something went wrong."),
      onError,
      incoming,
    );
  });
  server.on("upgrade", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    guardSocket(socket);
    callApp(
      () => {
        const adapter = current();
        if (adapter !== null) {
          adapter.upgrade(incoming, socket, head);
          return undefined;
        }
        if (options.upgrade === undefined) {
          refuseSocket(socket);
          return undefined;
        }
        return options.upgrade(incoming, socket, head);
      },
      () => socket.destroy(),
      onError,
      incoming,
    );
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
