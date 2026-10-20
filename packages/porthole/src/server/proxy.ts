import type { Access, Upstream } from "./types.ts";

/**
 * A url-mode upstream that relays each request to the running app by HTTP: the app believes it is
 * on its own origin (Host, Origin and Referer name it; dev servers check Host), learns nothing of
 * the proxy (no forwarding headers), and its answer comes back on the content origin (its
 * redirects to itself, and its cookies, stay there). WebSockets (a dev server's hot reload) don't
 * go through a fetch-style handler: the host relays those on its own upgrade path, after
 * `PortholeServer.access` lets the request in.
 */

export interface ProxyOptions {
  /** Where the app runs. Default: the external instance's own `url` (its origin; paths map 1:1). */
  readonly target?: (access: Access) => string;
  /** The fetch to relay with. Default: the global one. */
  readonly fetch?: typeof fetch;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** What a proxy in front of the host's server added: the app is told nothing of it. */
const FORWARDING = /^(?:x-forwarded-.*|forwarded|x-real-ip)$/u;

function connectionTokens(headers: Headers): Set<string> {
  return new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ""),
  );
}

/** The browser's request headers as the app at `target` gets them. */
export function upstreamRequestHeaders(headers: Headers, origin: string, target: string): Headers {
  const named = connectionTokens(headers);
  const out = new Headers();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (key === "host" || HOP_BY_HOP.has(key) || named.has(key) || FORWARDING.test(key)) {
      continue;
    }
    if (key === "origin" && value === origin) {
      out.set(name, target);
    } else if (key === "referer" && (value === origin || value.startsWith(`${origin}/`))) {
      out.set(name, `${target}${value.slice(origin.length)}`);
    } else {
      out.append(name, value);
    }
  }
  // The answer comes back decoded by fetch: ask for it plain rather than pay to decode it.
  out.set("accept-encoding", "identity");
  return out;
}

/** The app's answer headers as the browser on `origin` gets them. */
export function upstreamResponseHeaders(headers: Headers, origin: string, target: string): Headers {
  const named = connectionTokens(headers);
  const out = new Headers();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (
      HOP_BY_HOP.has(key) ||
      named.has(key) ||
      key === "set-cookie" ||
      // fetch decoded the body, whatever the app said it encoded.
      key === "content-encoding" ||
      key === "content-length"
    ) {
      continue;
    }
    if (key === "location") {
      out.set(name, onOrigin(value, origin, target));
    } else {
      out.append(name, value);
    }
  }
  for (const cookie of headers.getSetCookie()) {
    // Host-only on the content origin: an app's cookie never reaches the content domain's others.
    const [pair = "", ...attributes] = cookie.split(";");
    const kept = attributes.filter((attribute) => !/^\s*domain\s*=/iu.test(attribute));
    out.append("set-cookie", [pair, ...kept].join(";"));
  }
  return out;
}

/** `<target>/x` → `<origin>/x`; any other URL as it is. */
function onOrigin(location: string, origin: string, target: string): string {
  try {
    const url = new URL(location, target);
    return url.origin === target ? `${origin}${url.pathname}${url.search}${url.hash}` : location;
  } catch {
    return location;
  }
}

/** An `Upstream` that relays to the app by HTTP. */
export function proxyTo(options: ProxyOptions = {}): Upstream {
  const relay = options.fetch ?? fetch;
  return async (request, access) => {
    const where =
      options.target?.(access) ??
      (access.instance.document.kind === "external" ? access.instance.document.url : null);
    if (where === null) {
      return new Response("Not an app", { status: 502 });
    }
    const target = new URL(where).origin;
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    const answer = await relay(`${target}${url.pathname}${url.search}`, {
      method,
      headers: upstreamRequestHeaders(request.headers, access.origin, target),
      redirect: "manual",
      // The browser went away (`nodeHost` aborts it): so does the relay (P070).
      signal: request.signal,
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
    });
    return new Response(method === "HEAD" ? null : answer.body, {
      status: answer.status,
      statusText: answer.statusText,
      headers: upstreamResponseHeaders(answer.headers, access.origin, target),
    });
  };
}

type HeaderInput =
  | Headers
  | Iterable<readonly [string, string]>
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/** Headers from any of the shapes a relay has: fetch's, raw pairs, Node's. */
function headersOf(input: HeaderInput): Headers {
  if (input instanceof Headers) {
    return new Headers(input);
  }
  const out = new Headers();
  const entries =
    Symbol.iterator in input
      ? (input as Iterable<readonly [string, string]>)
      : Object.entries(input as Record<string, string | readonly string[] | undefined>).flatMap(
          ([name, value]): [string, string][] =>
            value === undefined
              ? []
              : typeof value === "string"
                ? [[name, value]]
                : value.map((each): [string, string] => [name, each]),
        );
  for (const [name, value] of entries) {
    out.append(name, value);
  }
  return out;
}

/** Whether a cookie is Porthole's own (sessions, entry nonces, the handoff). */
export const isPortholeCookie = (name: string): boolean =>
  /^(?:__Host-|__Secure-)?porthole-/u.test(name);

/**
 * Whether a `Set-Cookie` header sets one of Porthole's own names. A nameless cookie
 * (`=__Host-porthole-…=…`) counts by its value: an engine that sends one sends its value alone,
 * which reads as that name (P101).
 */
export function setsPortholeCookie(header: string): boolean {
  const [pair = ""] = header.split(";");
  const at = pair.indexOf("=");
  const name = (at < 0 ? pair : pair.slice(0, at)).trim();
  return isPortholeCookie(name) || (name === "" && isPortholeCookie(pair.slice(at + 1).trim()));
}

/** The cookie header without Porthole's own cookies, or null when nothing else is left. */
export function withoutPortholeCookies(cookie: string | null | undefined): string | null {
  const kept = (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !isPortholeCookie(part.split("=")[0]?.trim() ?? ""));
  return kept.length === 0 ? null : kept.join("; ");
}

/**
 * The header rewrite `proxyTo` makes, for a relay of its own (P072): a browser's request as the
 * app at `target` gets it (Host, Origin, Referer naming the app; no forwarding headers, no
 * Porthole cookies), and the app's answer as the browser on `origin` gets it (redirects and
 * cookies kept on the content origin, Porthole's cookies never set). `websocket` keeps the
 * upgrade's own headers. Pairs out, so a raw socket relay writes them as they are.
 */
export const upstreamHeaders = {
  request(
    input: HeaderInput,
    options: { readonly origin: string; readonly target: string; readonly websocket?: boolean },
  ): [string, string][] {
    const given = headersOf(input);
    const out = upstreamRequestHeaders(given, options.origin, options.target);
    const cookie = withoutPortholeCookies(given.get("cookie"));
    if (cookie === null) {
      out.delete("cookie");
    } else {
      out.set("cookie", cookie);
    }
    if (options.websocket === true) {
      out.delete("accept-encoding");
      for (const name of ["connection", "upgrade"]) {
        const value = given.get(name);
        if (value !== null) {
          out.set(name, value);
        }
      }
      out.set("host", new URL(options.target).host);
    }
    return [...out];
  },
  response(
    input: HeaderInput,
    options: { readonly origin: string; readonly target: string },
  ): [string, string][] {
    const answer = upstreamResponseHeaders(headersOf(input), options.origin, options.target);
    const cookies = answer.getSetCookie().filter((each) => !setsPortholeCookie(each));
    answer.delete("set-cookie");
    return [...answer, ...cookies.map((each): [string, string] => ["set-cookie", each])];
  },
};
