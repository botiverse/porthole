import { compile, type CompiledConfig } from "../compile/compile.ts";
import type { DisplayMode, EgressConfig } from "../config/schema.ts";
import {
  isExactOrigin,
  maybeSameSite,
  originMatchesSource,
  parseOrigin,
} from "../isolation/served.ts";
import type { FrameLocation, InstanceRef, ServedDocument } from "../isolation/types.ts";
import { sandboxProxyDocument } from "../mcp/proxy.ts";
import { createKeys, newTicket, ticketId } from "./keys.ts";
import { statusPage } from "./pages.ts";
import { memoryTicketStore } from "./tickets.ts";
import type { Access, PortholeServer, ServerOptions, TicketRecord, TicketStore } from "./types.ts";

/**
 * Paths on a content origin. Porthole's own live under `/__porthole/`; on a url-mode app's origin
 * every other path is the app's.
 */
const PREFIX = "/__porthole/";
/** A served document (shell, artifact page, sandbox proxy), by its instance's key. */
const DOCUMENT_PATH = /^\/__porthole\/d\/([a-z2-7]{16})$/u;
/** Where a url-mode app's ticket is taken, before the app's own landing path. */
const ENTER_PATH = "/__porthole/enter";

const LABEL = /^[a-z2-7]{24}$/u;
const DNS_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const NAME = /^[A-Za-z0-9._:-]{1,200}$/u;

const DEFAULT_TICKET_SECONDS = 60;
const MAX_TICKET_SECONDS = 600;
const DEFAULT_SESSION_SECONDS = 3_600;
const MAX_SESSION_SECONDS = 30 * 24 * 3_600;
/** Browsers keep a cookie of up to 4 KB, name and attributes included. */
const MAX_COOKIE_BYTES = 3_800;

/** What a session cookie carries, signed: the instance, its viewer, and when it stops. */
interface Session {
  readonly i: InstanceRef;
  readonly w: string;
  readonly x: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Which configs a kind of served document may be served under. */
const MODES: Readonly<Record<Exclude<ServedDocument["kind"], "external">, readonly DisplayMode[]>> =
  {
    shell: ["inline", "artifact"],
    artifact: ["artifact"],
    "mcp-proxy": ["mcp-app"],
  };

function mergeEgress(base: EgressConfig, extra: EgressConfig | undefined): EgressConfig {
  if (extra === undefined) {
    return base;
  }
  const merged: { -readonly [K in keyof EgressConfig]: EgressConfig[K] } = {};
  for (const kind of ["connect", "script", "style", "img", "font", "media"] as const) {
    const origins = [...new Set([...(base[kind] ?? []), ...(extra[kind] ?? [])])];
    if (origins.length > 0) {
      merged[kind] = origins;
    }
  }
  return merged;
}

/** `instance` with only the fields Porthole reads, each checked: what a ticket and cookie carry. */
function cleanInstance(instance: unknown): InstanceRef {
  if (!isRecord(instance) || typeof instance.scope !== "string") {
    throw new TypeError("An instance needs a scope (a string)");
  }
  if (instance.scope.length === 0 || instance.scope.length > 512) {
    throw new TypeError("An instance's scope is 1 to 512 characters");
  }
  const document = instance.document;
  if (!isRecord(document)) {
    throw new TypeError("An instance needs a document");
  }
  const name = (value: unknown, what: string): string => {
    if (typeof value !== "string" || !NAME.test(value)) {
      throw new TypeError(`${what} must be 1 to 200 of A-Z a-z 0-9 . _ : -`);
    }
    return value;
  };
  const optionalName = (value: unknown, what: string): { preset?: string } =>
    value === undefined ? {} : { preset: name(value, what) };
  let clean: ServedDocument;
  switch (document.kind) {
    case "shell":
      clean = { kind: "shell", preset: name(document.preset, "A shell's preset") };
      break;
    case "artifact":
      clean = {
        kind: "artifact",
        id: name(document.id, "An artifact's id"),
        version: name(document.version, "An artifact's version"),
        ...optionalName(document.preset, "An artifact's preset"),
      };
      break;
    case "mcp-proxy":
      clean = {
        kind: "mcp-proxy",
        ...optionalName(document.preset, "The proxy's preset"),
        ...(document.egress === undefined ? {} : { egress: document.egress as EgressConfig }),
      };
      break;
    case "external": {
      let url: URL;
      try {
        url = new URL(String(document.url));
      } catch {
        throw new TypeError("An external instance's url must be a URL");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("An external instance's url must be http(s)");
      }
      clean = { kind: "external", url: url.href };
      break;
    }
    default:
      throw new TypeError(`Unknown served document kind ${JSON.stringify(document.kind)}`);
  }
  return { scope: instance.scope, document: clean };
}

function seconds(value: number | undefined, fallback: number, max: number, what: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${what} must be an integer from 1 to ${max}`);
  }
  return value;
}

/** The cookies a request carries, as name → values (a name may come twice: partitioned or not). */
function cookiesOf(request: Request): [string, string][] {
  const header = request.headers.get("cookie") ?? "";
  const pairs: [string, string][] = [];
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0) {
      pairs.push([part.slice(0, at).trim(), part.slice(at + 1).trim()]);
    }
  }
  return pairs;
}

/**
 * Serving for domain, artifact and url modes, and the MCP Apps sandbox proxy (P016, P020): a
 * fetch-style handler a host's backend mounts in front of its own routes, plus `issue`, which the
 * host's authenticated API calls once it has decided a viewer may see an instance.
 */
export function createServer(options: ServerOptions): PortholeServer {
  const { content } = options;
  const domain = content.domain;
  if (!DNS_NAME.test(domain)) {
    throw new TypeError(`content.domain ${JSON.stringify(domain)} is not a lowercase DNS name`);
  }
  const loopback = domain === "localhost" || domain.endsWith(".localhost");
  if (content.scheme === "http" && !loopback) {
    throw new TypeError("content.scheme http is for localhost only: serve content over https");
  }
  if (content.scheme !== "http" && content.scheme !== "https") {
    throw new TypeError('content.scheme must be "https" or "http"');
  }
  if (
    content.port !== undefined &&
    (!Number.isInteger(content.port) || content.port < 1 || content.port > 65_535)
  ) {
    throw new TypeError("content.port must be a port number");
  }
  const keys = createKeys(options.secret);
  const secure = content.scheme === "https";
  const defaultPort = secure ? 443 : 80;
  const portPart =
    content.port === undefined || content.port === defaultPort ? "" : `:${content.port}`;
  const originOfLabel = (label: string): string =>
    `${content.scheme}://${label}.${domain}${portPart}`;
  const contentSource = `${content.scheme}://*.${domain}${portPart}`;
  const sampleHost = `${keys.label("")}.${domain}`;
  const sampleOrigin = originOfLabel(keys.label(""));

  if (options.hostOrigins.length === 0) {
    throw new TypeError("hostOrigins must name the origins that embed content");
  }
  for (const origin of options.hostOrigins) {
    const parsed = isExactOrigin(origin) ? parseOrigin(origin) : null;
    if (parsed === null) {
      throw new TypeError(`hostOrigins: ${JSON.stringify(origin)} is not an exact origin`);
    }
    if (
      parsed.host === domain ||
      parsed.host.endsWith(`.${domain}`) ||
      maybeSameSite(parsed.host, sampleHost)
    ) {
      throw new TypeError(
        `hostOrigins: ${origin} may be the same site as the content domain ${domain}: serve content from a registrable domain the host uses for nothing else`,
      );
    }
  }
  const frameAncestors = options.hostOrigins.join(" ");

  const compiled = new Map<string, CompiledConfig>();
  for (const [name, config] of Object.entries(options.configs)) {
    compiled.set(name, compile(config));
  }
  const tickets: TicketStore = options.tickets ?? memoryTicketStore();

  const page = (status: number, title: string, detail: string, method?: string): Response =>
    statusPage(status, title, detail, frameAncestors, method);

  /** The config a served document is served under, checked to fit it and this server. */
  function configFor(name: string, kind: keyof typeof MODES): CompiledConfig {
    const each = compiled.get(name);
    if (each === undefined) {
      throw new TypeError(`No config named ${JSON.stringify(name)} (ServerOptions.configs)`);
    }
    const { config } = each;
    if (config.isolation !== "domain" || !MODES[kind].includes(config.mode)) {
      throw new TypeError(
        `The config ${JSON.stringify(name)} (${config.mode}, ${config.isolation}) can't serve a ${kind}: it needs ${MODES[kind].join(" or ")} mode with domain isolation`,
      );
    }
    if (!config.contentOrigins.some((source) => originMatchesSource(sampleOrigin, source))) {
      throw new TypeError(
        `The config ${JSON.stringify(name)}'s contentOrigins don't include this server's (${contentSource})`,
      );
    }
    return each;
  }

  /** The compiled config an instance's document goes out under: its CSP, its shell. */
  function compiledFor(instance: InstanceRef): CompiledConfig | null {
    const { document } = instance;
    switch (document.kind) {
      case "shell":
        return configFor(document.preset, "shell");
      case "artifact":
        return configFor(document.preset ?? "artifact", "artifact");
      case "mcp-proxy": {
        const { config } = configFor(document.preset ?? "mcpApp", "mcp-proxy");
        return compile({ ...config, egress: mergeEgress(config.egress, document.egress) });
      }
      case "external":
        return null;
    }
  }

  function check(instance: InstanceRef): void {
    const { document } = instance;
    switch (document.kind) {
      case "shell":
        compiledFor(instance);
        return;
      case "artifact":
        compiledFor(instance);
        if (options.artifacts === undefined) {
          throw new TypeError("Artifact pages need ServerOptions.artifacts");
        }
        return;
      case "mcp-proxy":
        // Compiling validates the view's egress as a config would be.
        compiledFor(instance);
        return;
      case "external":
        if (options.upstream === undefined) {
          throw new TypeError("Url mode needs ServerOptions.upstream: nothing would serve the app");
        }
    }
  }

  async function documentOf(
    instance: InstanceRef,
  ): Promise<{ readonly html: string; readonly csp: string } | null> {
    const { document } = instance;
    const config = compiledFor(instance);
    if (config === null) {
      return null;
    }
    const origins = options.hostOrigins;
    switch (document.kind) {
      case "shell":
        return { html: config.shellDocument({ origins, cspMeta: false }), csp: config.csp };
      case "artifact": {
        const stored = await options.artifacts?.get(document.id, document.version);
        if (stored === null || stored === undefined || typeof stored.html !== "string") {
          return null;
        }
        return {
          html: config.shellDocument({ origins, document: stored.html, cspMeta: false }),
          csp: config.csp,
        };
      }
      case "mcp-proxy":
        return { html: sandboxProxyDocument(config, origins), csp: config.csp };
      case "external":
        return null;
    }
  }

  const cookieName = (key: string): string =>
    secure ? `__Host-porthole-${key}` : `porthole-${key}`;
  const ourCookie = (name: string): boolean =>
    name.startsWith("porthole-") || name.startsWith("__Host-porthole-");

  /**
   * The cookie a taken ticket buys: this origin only (`__Host-` over https), never readable by the
   * content (`HttpOnly`). In a frame it is a third party's: `SameSite=None`, partitioned by the
   * page that frames it; on a tab of its own, `Lax`. (Engines that keep no cookie in a cross-site
   * frame, measured: WebKit, still get the document, which comes with the ticket's answer.)
   */
  function sessionCookie(request: Request, record: TicketRecord): string {
    const sessionSeconds = record.sessionSeconds ?? DEFAULT_SESSION_SECONDS;
    const session: Session = {
      i: record.instance,
      w: record.viewer,
      x: Date.now() + sessionSeconds * 1_000,
    };
    const framed = request.headers.get("sec-fetch-dest") !== "document";
    return [
      `${cookieName(keys.instanceKey(record.instance))}=${keys.sign(session)}`,
      "Path=/",
      "HttpOnly",
      `Max-Age=${sessionSeconds}`,
      ...(framed
        ? ["Secure", "SameSite=None", "Partitioned"]
        : [...(secure ? ["Secure"] : []), "SameSite=Lax"]),
    ].join("; ");
  }

  /** The access a request's own cookies give on `label`'s origin, for `key`'s instance or the app. */
  function accessOf(request: Request, label: string, key: string | null): Access | null {
    let best: Access | null = null;
    for (const [name, value] of cookiesOf(request)) {
      if (!(key === null ? ourCookie(name) : name === cookieName(key))) {
        continue;
      }
      const session = keys.verify(value);
      if (
        !isRecord(session) ||
        typeof session.w !== "string" ||
        typeof session.x !== "number" ||
        session.x <= Date.now()
      ) {
        continue;
      }
      let instance: InstanceRef;
      try {
        instance = cleanInstance(session.i);
      } catch {
        continue;
      }
      if (
        keys.label(instance.scope) !== label ||
        (key === null ? instance.document.kind !== "external" : keys.instanceKey(instance) !== key)
      ) {
        continue;
      }
      if (best === null || session.x > best.expiresAt) {
        best = { instance, viewer: session.w, origin: originOfLabel(label), expiresAt: session.x };
      }
    }
    return best;
  }

  /** A taken ticket, if it is good for `label`'s origin. */
  async function take(ticket: string | null, label: string): Promise<TicketRecord | null> {
    if (ticket === null || ticket.length === 0 || ticket.length > 128) {
      return null;
    }
    const record = await tickets.take(ticketId(ticket));
    if (record === null || record.expiresAt <= Date.now()) {
      return null;
    }
    try {
      const instance = cleanInstance(record.instance);
      return keys.label(instance.scope) === label ? { ...record, instance } : null;
    } catch {
      return null;
    }
  }

  function documentHeaders(csp: string): Headers {
    return new Headers({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `${csp}; frame-ancestors ${frameAncestors}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
  }

  async function serveDocument(
    request: Request,
    url: URL,
    label: string,
    key: string,
  ): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return page(405, "Not allowed", "Content here is only read.", method);
    }
    let access: Access | null = null;
    let cookie: string | null = null;
    // The ticket's own answer carries the document: an engine that keeps no cookie in a frame
    // still shows it. The cookie serves what follows (a reload), where the engine keeps it.
    const record = method === "GET" ? await take(url.searchParams.get("ticket"), label) : null;
    if (
      record !== null &&
      record.instance.document.kind !== "external" &&
      keys.instanceKey(record.instance) === key
    ) {
      cookie = sessionCookie(request, record);
      access = {
        instance: record.instance,
        viewer: record.viewer,
        origin: originOfLabel(label),
        expiresAt: Date.now() + (record.sessionSeconds ?? DEFAULT_SESSION_SECONDS) * 1_000,
      };
    }
    access ??= accessOf(request, label, key);
    if (access === null) {
      return page(
        401,
        "This link has been used",
        "Content here opens once per link. Open it again from the app that showed it.",
        method,
      );
    }
    const served = await documentOf(access.instance);
    if (served === null) {
      return page(404, "Not found", "This page, or this version of it, doesn't exist.", method);
    }
    const headers = documentHeaders(served.csp);
    if (cookie !== null) {
      headers.set("set-cookie", cookie);
    }
    return new Response(method === "HEAD" ? null : served.html, { status: 200, headers });
  }

  async function enter(request: Request, url: URL, label: string): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method !== "GET") {
      return page(405, "Not allowed", "Open this link in a browser.", method);
    }
    const record = await take(url.searchParams.get("ticket"), label);
    if (record === null || record.instance.document.kind !== "external") {
      return page(
        403,
        "This link has been used",
        "A link into an app works once, for a short time. Open it again from the app that showed it.",
      );
    }
    const target = new URL(record.instance.document.url);
    return new Response(null, {
      status: 303,
      headers: {
        location: `${target.pathname}${target.search}${target.hash}`,
        "set-cookie": sessionCookie(request, record),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  /** The request as the upstream gets it: without Porthole's cookies. */
  function forUpstream(request: Request): Request {
    const headers = new Headers(request.headers);
    const kept = cookiesOf(request)
      .filter(([name]) => !ourCookie(name))
      .map(([name, value]) => `${name}=${value}`);
    if (kept.length > 0) {
      headers.set("cookie", kept.join("; "));
    } else {
      headers.delete("cookie");
    }
    return new Request(request, { headers });
  }

  /** The upstream's answer as the browser gets it: framable by the host only, our cookies kept ours. */
  function fromUpstream(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.delete("set-cookie");
    for (const cookie of response.headers.getSetCookie()) {
      const name = cookie.split("=")[0]?.trim() ?? "";
      if (!ourCookie(name)) {
        headers.append("set-cookie", cookie);
      }
    }
    // Only the host may frame the app; any policy of the app's own still applies too.
    headers.append("content-security-policy", `frame-ancestors ${frameAncestors}`);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  async function serveApp(request: Request, label: string): Promise<Response> {
    const method = request.method.toUpperCase();
    const access = accessOf(request, label, null);
    if (access === null) {
      return page(
        401,
        "Open this from the app",
        "This address shows an app only to the people the app opens it for.",
        method,
      );
    }
    if (options.upstream === undefined) {
      return page(502, "Nothing serves this app", "The server has no upstream for apps.", method);
    }
    try {
      return fromUpstream(await options.upstream(forUpstream(request), access));
    } catch {
      return page(502, "The app didn't answer", "Its server couldn't be reached.", method);
    }
  }

  /** The label a request is for: null when it isn't under the content domain at all. */
  function labelOf(request: Request): { readonly url: URL; readonly label: string } | null {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (host !== domain && !host.endsWith(`.${domain}`)) {
      return null;
    }
    return { url, label: host.slice(0, Math.max(0, host.length - domain.length - 1)) };
  }

  return {
    contentSource,

    originFor: (scope) => originOfLabel(keys.label(scope)),

    async issue(instance, grant): Promise<FrameLocation> {
      const clean = cleanInstance(instance);
      check(clean);
      if (
        typeof grant.viewer !== "string" ||
        grant.viewer.length === 0 ||
        grant.viewer.length > 512
      ) {
        throw new TypeError("A grant's viewer is 1 to 512 characters");
      }
      const ttl = seconds(
        grant.ttlSeconds,
        DEFAULT_TICKET_SECONDS,
        MAX_TICKET_SECONDS,
        "ttlSeconds",
      );
      const sessionSeconds = seconds(
        grant.sessionSeconds,
        DEFAULT_SESSION_SECONDS,
        MAX_SESSION_SECONDS,
        "sessionSeconds",
      );
      const key = keys.instanceKey(clean);
      const probe = keys.sign({ i: clean, w: grant.viewer, x: Number.MAX_SAFE_INTEGER });
      if (cookieName(key).length + probe.length + 120 > MAX_COOKIE_BYTES) {
        throw new TypeError("This instance is too large to carry in a cookie (fewer origins?)");
      }
      const ticket = newTicket();
      await tickets.put(ticketId(ticket), {
        instance: clean,
        viewer: grant.viewer,
        expiresAt: Date.now() + ttl * 1_000,
        ...(grant.sessionSeconds === undefined ? {} : { sessionSeconds }),
      });
      const origin = originOfLabel(keys.label(clean.scope));
      const path =
        clean.document.kind === "external"
          ? `${ENTER_PATH}?ticket=${ticket}`
          : `${PREFIX}d/${key}?ticket=${ticket}`;
      return { url: `${origin}${path}`, origin };
    },

    async access(request) {
      const at = labelOf(request);
      return at === null || !LABEL.test(at.label) ? null : accessOf(request, at.label, null);
    },

    async handle(request) {
      const at = labelOf(request);
      if (at === null) {
        return null;
      }
      const { url, label } = at;
      const method = request.method.toUpperCase();
      try {
        if (!LABEL.test(label)) {
          return page(404, "Nothing here", "This address names no content.", method);
        }
        if (url.pathname === ENTER_PATH) {
          return await enter(request, url, label);
        }
        const document = DOCUMENT_PATH.exec(url.pathname);
        if (document?.[1] !== undefined) {
          return await serveDocument(request, url, label, document[1]);
        }
        if (url.pathname.startsWith(PREFIX)) {
          return page(404, "Nothing here", "This address names no content.", method);
        }
        return await serveApp(request, label);
      } catch {
        return page(500, "Something went wrong", "This content couldn't be served.", method);
      }
    },
  };
}
