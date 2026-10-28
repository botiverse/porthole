import { compile, type CompiledConfig } from "../compile/compile.ts";
import type { DisplayMode, EgressConfig } from "../config/schema.ts";
import {
  hostOriginProblem,
  maybeSameSite,
  originMatchesSource,
  parseOrigin,
} from "../isolation/served.ts";
import type { FrameLocation, InstanceRef, ServedDocument } from "../isolation/types.ts";
import { sandboxProxyDocument } from "../mcp/proxy.ts";
import { base32, createKeys, newTicket, ticketId } from "./keys.ts";
import { randomBytes } from "./crypto.ts";
import { isHostLabel, reservedLabels } from "./naming.ts";
import { enterPage, pageScript, SESSION_PATH, statusPage } from "./pages.ts";
import { libraryFile } from "./libraries.ts";
import { isNavigation, ownLoad, serveAsset, serveFile } from "./files.ts";
import { nestedAncestors, nestedShellResponse } from "./nested.ts";
import { DEFAULT_ENTRY } from "../files/paths.ts";
import { isPortholeCookie, setsPortholeCookie } from "./proxy.ts";
import {
  assetCodeRuns,
  assetCspDirectives,
  INERT_FILE_CSP,
  servedDocumentCsp,
  servedPermissionsPolicy,
} from "../compile/policy.ts";
import { parseViewer, type ViewerInfo } from "../runtime/levels.ts";
import type { FrameBlock } from "../host/types.ts";
import { memoryTicketStore } from "./tickets.ts";
import type {
  Access,
  AuthorizeAnswer,
  Grant,
  StoredAsset,
  PortholeServer,
  ServerOptions,
  StoredFiles,
  StoredVersion,
  TicketRecord,
  TicketStore,
} from "./types.ts";

/**
 * Paths on a content origin. Porthole's own live under `/__porthole/`; on a url-mode app's origin
 * every other path is the app's.
 */
const PREFIX = "/__porthole/";
/** A served document (shell, artifact page, sandbox proxy), by its instance's key. */
const DOCUMENT_PATH = /^\/__porthole\/d\/([a-z2-7]{16})$/u;
/**
 * A file set's files in a frame (P083): `/__porthole/f/<sealed access>/<path>`. The access is
 * in the path, so a frame whose engine keeps no cookie (WebKit, P025) loads them too.
 */
const FILES_PATH = /^\/__porthole\/f\/([A-Za-z0-9_-]{40,4096})(\/.*)?$/u;
const FILES_PREFIX = "/__porthole/f/";
/** An asset's address (P089): `/_blob/` and 32 lowercase hex characters (`ASSET_ID`). */
const ASSET_ROUTE = /^\/_blob\/([0-9a-f]{32})$/u;
/** The same, under a frame's sealed files' address (P091): `<base>__porthole/blob/<id>`. */
const SEALED_ASSET = /^\/__porthole\/blob\/([0-9a-f]{32})$/u;
/** How long a sealed files' address opens a page's files on its own (P083); the shell renews it. */
const FILES_ADDRESS_MS = 3_600_000;
/** Below a sealed address: where the page's shell renews it (no file has a `__porthole/` path). */
const RENEW_PATH = "/__porthole/renew";
/**
 * A clean address's base (P081): a path ending in `/`, each segment of letters, digits and
 * `. _ : ~ -` (nothing a CSP source or a header would read otherwise), never `.` or `..`.
 */
const BASE = /^\/(?:(?!\.{1,2}\/)[A-Za-z0-9._:~-]{1,200}\/){0,16}$/u;
/** Where a url-mode app's ticket is taken, before the app's own landing path. */
const ENTER_PATH = "/__porthole/enter";
/** Where a redirect entry's code is redeemed, before its clean address (P068). */
const ENTRY_PATH = "/__porthole/entry";
/** How long a redirect entry may take (the person may sign in on the way), and its code. */
const ENTRY_STATE_MS = 5 * 60_000;
const ENTRY_CODE_SECONDS = 60;
/** How long an entered path is remembered, so an entry that kept no cookie doesn't loop. */
const ENTERED_SECONDS = 60;
const NONCE = /^[a-z2-7]{16}$/u;
const MAX_PATH = 2_048;

const LABEL = /^[a-z2-7]{24}$/u;
/** A host's opaque subject and reason codes. */
const SUBJECT_MAX = 512;
const CODE = /^[a-z0-9-]{1,40}$/u;
const DNS_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const NAME = /^[A-Za-z0-9._:-]{1,200}$/u;

const DEFAULT_TICKET_SECONDS = 60;
const MAX_TICKET_SECONDS = 600;
const DEFAULT_SESSION_SECONDS = 3_600;
const MAX_SESSION_SECONDS = 30 * 24 * 3_600;
/** Browsers keep a cookie of up to 4 KB, name and attributes included. */
const MAX_COOKIE_BYTES = 3_800;

/** A host (and port) as it compares: lowercase, no trailing dot, no default port. */
function normalHost(value: string, protocol: string): string {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/\.(?=:\d+$|$)/u, "");
  const defaultPort = protocol === "https:" ? ":443" : protocol === "http:" ? ":80" : "";
  return defaultPort !== "" && host.endsWith(defaultPort)
    ? host.slice(0, -defaultPort.length)
    : host;
}

/**
 * What a session cookie carries, signed: the instance, its viewer (or anonymous), the host's
 * opaque subject, and when it stops.
 */
interface Session {
  readonly i: InstanceRef;
  readonly w: string;
  readonly x: number;
  readonly a?: 1;
  readonly s?: string;
  /** The clean path a document was entered at (P068): it is served there by this cookie. */
  readonly p?: string;
  /** A file set's base (P081): every path under it is served by this cookie. */
  readonly b?: string;
  /** Whether the base is the version's own address (the app said so): its files are immutable. */
  readonly k?: 1;
}

/** Where a request falls under a file set's base: the base, and the path below it. */
interface FilesAt {
  readonly base: string;
  readonly rest: string;
  readonly search: string;
  readonly pinned: boolean;
  /** The CSP source the version's files load from (P082). */
  readonly source: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStoredFiles = (stored: StoredVersion): stored is StoredFiles =>
  isRecord(stored) &&
  isRecord((stored as Partial<StoredFiles>).files) &&
  typeof (stored as Partial<StoredFiles>).read === "function";

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
  // What the host's config opens to any https site stays; a view can't ask for it (P059).
  if (base.anyHttps !== undefined) {
    merged.anyHttps = base.anyHttps;
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

/**
 * The cookies a request carries, as name → values (a name may come twice: partitioned or not).
 * Only spaces and tabs are trimmed, as browsers trim them (P101): a name a sibling set with a
 * leading U+00A0 is no `__Host-` name, though JavaScript's `trim` would make it one.
 */
function cookiesOf(request: Request): [string, string][] {
  const header = request.headers.get("cookie") ?? "";
  const pairs: [string, string][] = [];
  const blank = /^[ \t]+|[ \t]+$/gu;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0) {
      pairs.push([part.slice(0, at).replace(blank, ""), part.slice(at + 1).replace(blank, "")]);
    }
  }
  return pairs;
}

/** The artifact version a file set is, for its pages' notices to the host (P098). */
const versionOf = (instance: InstanceRef): { artifact?: { id: string; version: string } } =>
  instance.document.kind === "artifact"
    ? { artifact: { id: instance.document.id, version: instance.document.version } }
    : {};

/**
 * Serving for domain, artifact and url modes, and the MCP Apps sandbox proxy (P016, P020): a
 * fetch-style handler a host's backend mounts in front of its own routes, plus `issue`, which the
 * host's authenticated API calls once it has decided a viewer may see an instance.
 */
/** A grant's viewer for the display's bridge (P087), checked; null without a level. */
function viewerOfGrant(grant: Grant): ViewerInfo | null {
  if (grant.level === undefined) {
    if (grant.user !== undefined) {
      throw new TypeError("A grant's user comes with its level");
    }
    return null;
  }
  const viewer = parseViewer({
    level: grant.level,
    ...(grant.user === undefined ? {} : { id: grant.user.id, name: grant.user.name }),
  });
  if (viewer === null) {
    throw new TypeError(
      "A grant's level is view, interact, admin or owner; its user's id and name 1 to 256 characters",
    );
  }
  return viewer;
}

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
  const isReserved = reservedLabels(content.reserved);
  /** The label a scope is served on: the host's naming, checked, or the keyed default. */
  const nameOf = (scope: string): string => {
    if (content.name === undefined) {
      return keys.label(scope);
    }
    const label = content.name(scope);
    if (!isHostLabel(label) || isReserved(label)) {
      throw new TypeError(
        `content.name gave ${JSON.stringify(label)} for a scope: it must be one lowercase DNS label (a-z 0-9 -, at most 63, not xn--), not reserved`,
      );
    }
    return label;
  };
  /** Whether a request's label may be one this server named. */
  const ours = (label: string): boolean =>
    !isReserved(label) && (content.name === undefined ? LABEL.test(label) : isHostLabel(label));
  const secure = content.scheme === "https";
  const defaultPort = secure ? 443 : 80;
  const portPart =
    content.port === undefined || content.port === defaultPort ? "" : `:${content.port}`;
  const originOfLabel = (label: string): string =>
    `${content.scheme}://${label}.${domain}${portPart}`;
  const contentSource = `${content.scheme}://*.${domain}${portPart}`;
  const sampleHost = `${keys.label("")}.${domain}`;
  const sampleOrigin = originOfLabel(keys.label(""));
  const authorize = options.authorize;
  const authorizeTtl = authorize?.ttlSeconds ?? 0;
  if (!Number.isInteger(authorizeTtl) || authorizeTtl < 0 || authorizeTtl > 300) {
    throw new TypeError("authorize.ttlSeconds must be an integer from 0 to 300");
  }
  const answers = new Map<
    string,
    {
      readonly answer: AuthorizeAnswer;
      readonly until: number;
      readonly scope: string;
      readonly subject: string | null;
    }
  >();

  if (options.hostOrigins.length === 0) {
    throw new TypeError("hostOrigins must name the origins that embed content");
  }
  for (const origin of options.hostOrigins) {
    const problem = hostOriginProblem(origin);
    if (problem !== null) {
      throw new TypeError(`hostOrigins: ${problem}`);
    }
    // A desktop app's own scheme (ferry://app) is never the same site as web content.
    const parsed = parseOrigin(origin);
    if (parsed === null) {
      continue;
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
  let authorizeUrl: URL | null = null;
  if (options.entry !== undefined) {
    try {
      authorizeUrl = new URL(options.entry.authorizeUrl);
    } catch {
      throw new TypeError("entry.authorizeUrl must be an absolute URL");
    }
    if (!options.hostOrigins.includes(authorizeUrl.origin) || authorizeUrl.hash !== "") {
      throw new TypeError(
        `entry.authorizeUrl must be on one of the host origins (${options.hostOrigins.join(", ")}), without a fragment`,
      );
    }
  }

  const compiled = new Map<string, CompiledConfig>();
  for (const [name, config] of Object.entries(options.configs)) {
    compiled.set(name, compile(config));
  }
  const tickets: TicketStore = options.tickets ?? memoryTicketStore();

  /** A page saying why there is nothing to show, told to the host too (its reason, P040). */
  const page = (
    status: number,
    title: string,
    detail: string,
    method?: string,
    reason: FrameBlock = status === 404 ? "not-found" : status === 502 ? "upstream" : "error",
    code?: string,
  ): Response =>
    statusPage(status, title, detail, frameAncestors, method, reason, options.hostOrigins, code);

  /**
   * The host's check on a request its cookie (or ticket) let in (P050): null to go on, or the
   * page saying it's denied. Answers are reused only for the host's own `ttlSeconds`.
   */
  async function denied(request: Request, access: Access): Promise<Response | null> {
    if (authorize === undefined) {
      return null;
    }
    const key = JSON.stringify([
      keys.instanceKey(access.instance),
      access.viewer,
      access.subject ?? null,
      access.expiresAt,
    ]);
    const at = Date.now();
    let answer = authorizeTtl > 0 ? answers.get(key) : undefined;
    if (answer === undefined || answer.until <= at) {
      let given: AuthorizeAnswer;
      try {
        given = await authorize.check({
          scope: access.instance.scope,
          instance: access.instance,
          viewer: access.viewer,
          anonymous: access.anonymous === true,
          ...(access.subject === undefined ? {} : { subject: access.subject }),
          request,
        });
      } catch {
        given = { allow: false };
      }
      answer = {
        answer: given,
        until: at + authorizeTtl * 1_000,
        scope: access.instance.scope,
        subject: access.subject ?? null,
      };
      if (authorizeTtl > 0) {
        if (answers.size > 10_000) {
          answers.clear();
        }
        answers.set(key, answer);
      }
    }
    // Only an explicit allow lets the request on: anything else the check gives is a deny.
    const given = answer.answer as Partial<{ allow: unknown; code: unknown }> | null | undefined;
    if (given?.allow === true) {
      return null;
    }
    const code = typeof given?.code === "string" && CODE.test(given.code) ? given.code : undefined;
    return page(
      403,
      "You can't open this anymore",
      "The app that showed it no longer lets you see it here.",
      request.method.toUpperCase(),
      "denied",
      code,
    );
  }

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

  async function documentOf(instance: InstanceRef): Promise<
    | {
        readonly html: string;
        /** An artifact's own page, before the shell (a nested page's is made apart, P111). */
        readonly document?: string;
        readonly compiled: CompiledConfig;
        /** Whether its CSP opens its artifact's asset library (P089): an artifact's page. */
        readonly assets: boolean;
      }
    | { readonly files: StoredFiles; readonly compiled: CompiledConfig }
    | null
  > {
    const { document } = instance;
    const config = compiledFor(instance);
    if (config === null) {
      return null;
    }
    const origins = options.hostOrigins;
    switch (document.kind) {
      case "shell":
        return {
          html: config.shellDocument({ origins, cspMeta: false }),
          compiled: config,
          assets: false,
        };
      case "artifact": {
        const stored = await options.artifacts?.get(document.id, document.version);
        if (stored === null || stored === undefined) {
          return null;
        }
        // A version made of files (P081): served file by file under its base.
        if (isStoredFiles(stored)) {
          return { files: stored, compiled: config };
        }
        if (typeof stored.html !== "string") {
          return null;
        }
        return {
          html: config.shellDocument({ origins, document: stored.html, cspMeta: false }),
          document: stored.html,
          compiled: config,
          assets: true,
        };
      }
      case "mcp-proxy":
        return { html: sandboxProxyDocument(config, origins), compiled: config, assets: false };
      case "external":
        return null;
    }
  }

  const cookieName = (key: string): string =>
    secure ? `__Host-porthole-${key}` : `porthole-${key}`;
  /**
   * Whether a cookie is one this server set, by its name (P101). Over https only `__Host-` names:
   * every label is same-site with every other (P047), and a sibling label (a url-mode app, an
   * app's preview) can set any other name for the whole content domain (`Domain=`), never a
   * `__Host-` one, which the browser keeps to the origin that set it. Over plain http (loopback
   * dev only: `createServer` refuses http elsewhere) the names have no prefix, set and read:
   * `__Host-` needs `Secure`, and WebKit keeps no `Secure` cookie on a tab of http://*.localhost
   * (measured). A sibling there can set the very name, so a copy of one of this label's own
   * sessions or nonces is read: someone must hold one to plant it, on a developer's own server.
   * Another label's session is never this label's, either scheme (its signed scope). Case and
   * every byte count: `__host-` or a name with anything before the prefix is not ours. What
   * Porthole strips from an app's requests and answers is wider (`isPortholeCookie`).
   */
  const ourCookie = (name: string): boolean =>
    name.startsWith(secure ? "__Host-porthole-" : "porthole-");

  /**
   * The cookie a taken ticket buys: this origin only (`__Host-` over https), never readable by the
   * content (`HttpOnly`). In a frame it is a third party's: `SameSite=None`, partitioned by the
   * page that frames it; on a tab of its own, `Lax`. (Engines that keep no cookie in a cross-site
   * frame, measured: WebKit, still get the document, which comes with the ticket's answer.)
   */
  function sessionCookie(
    request: Request,
    record: TicketRecord,
    at: { readonly p?: string; readonly b?: string; readonly k?: 1 } = {},
  ): string {
    const sessionSeconds = record.sessionSeconds ?? DEFAULT_SESSION_SECONDS;
    const session: Session = {
      i: record.instance,
      w: record.viewer,
      x: Date.now() + sessionSeconds * 1_000,
      ...(record.anonymous === true ? { a: 1 as const } : {}),
      ...(record.subject === undefined ? {} : { s: record.subject }),
      ...(at.p === undefined ? {} : { p: at.p }),
      ...(at.b === undefined ? {} : { b: at.b }),
      ...(at.k === undefined ? {} : { k: at.k }),
    };
    return [
      `${cookieName(keys.instanceKey(record.instance))}=${keys.sign(session)}`,
      "Path=/",
      "HttpOnly",
      `Max-Age=${sessionSeconds}`,
      ...cookieContext(request),
    ].join("; ");
  }

  /** A cookie's context: a third party's in a frame (partitioned), first-party `Lax` on a tab. */
  function cookieContext(request: Request): string[] {
    const framed = request.headers.get("sec-fetch-dest") !== "document";
    return framed
      ? ["Secure", "SameSite=None", "Partitioned"]
      : [...(secure ? ["Secure"] : []), "SameSite=Lax"];
  }

  /** The cookie a redirect entry's browser holds while it is away (P068), by its nonce. */
  const nonceCookie = (nonce: string): string => cookieName(`n-${nonce}`);
  /**
   * What an entered path's nonce cookie says after its code was redeemed: the loop guard. Its
   * label's and its path's (P101): a mark redeemed on one label, planted on another, is nothing.
   */
  const enteredMark = (label: string, pathname: string): string =>
    `e.${keys.instanceKey({ entered: pathname, label })}`;

  /**
   * Whether a url-mode app's request may ride its cookie (P101): what the app's own origin asks
   * (its `Origin`, or `Sec-Fetch-Site` `same-origin`; `none` is the person's own address bar),
   * and, where `navigable`, a navigation that opens it (GET or HEAD: the host's frame, a link, a
   * redirect back from sign-in). Another origin (a sibling label's app, another frame on the
   * host's page, an opaque origin's `null`) gets no write, no subresource, no socket. A request
   * with neither header is no browser's (a browser always sends `Origin` on a socket and on a
   * write, and fetch metadata on everything, where it sends them at all).
   */
  function fromItsOwnOrigin(request: Request, label: string, navigable: boolean): boolean {
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== originOfLabel(label)) {
      return false;
    }
    const site = request.headers.get("sec-fetch-site");
    if (site === null || site === "same-origin" || site === "none") {
      return true;
    }
    const method = request.method.toUpperCase();
    return (
      navigable &&
      request.headers.get("sec-fetch-mode") === "navigate" &&
      (method === "GET" || method === "HEAD")
    );
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
        session.x <= Date.now() ||
        (session.s !== undefined && typeof session.s !== "string")
      ) {
        continue;
      }
      let instance: InstanceRef;
      try {
        instance = cleanInstance(session.i);
      } catch {
        continue;
      }
      let named: string;
      try {
        named = nameOf(instance.scope);
      } catch {
        continue;
      }
      if (
        named !== label ||
        (key === null ? instance.document.kind !== "external" : keys.instanceKey(instance) !== key)
      ) {
        continue;
      }
      if (best === null || session.x > best.expiresAt) {
        best = {
          instance,
          viewer: session.w,
          origin: originOfLabel(label),
          expiresAt: session.x,
          ...(session.a === 1 ? { anonymous: true } : {}),
          ...(typeof session.s === "string" ? { subject: session.s } : {}),
        };
      }
    }
    return best;
  }

  /**
   * The access a request's cookies give to the document entered at `pathname` (P068), or to a
   * file set's path under the base it was entered at (P081): with where the path falls under the
   * base, or the base itself to go to (`/v/3` → `/v/3/`).
   */
  function accessAtPath(
    request: Request,
    label: string,
    url: URL,
  ): {
    readonly access: Access;
    readonly at?: FilesAt;
    readonly redirect?: string;
  } | null {
    const { pathname } = url;
    let best: { rank: number; access: Access; at?: FilesAt; redirect?: string } | null = null;
    for (const [name, value] of cookiesOf(request)) {
      if (!ourCookie(name)) {
        continue;
      }
      const session = keys.verify(value);
      if (!isRecord(session)) {
        continue;
      }
      const base = typeof session.b === "string" && BASE.test(session.b) ? session.b : null;
      const under = base !== null && pathname.startsWith(base);
      const atBase = base !== null && `${pathname}/` === base;
      if (
        (session.p !== pathname && !under && !atBase) ||
        typeof session.w !== "string" ||
        typeof session.x !== "number" ||
        session.x <= Date.now() ||
        (session.s !== undefined && typeof session.s !== "string")
      ) {
        continue;
      }
      let instance: InstanceRef;
      try {
        instance = cleanInstance(session.i);
        if (instance.document.kind === "external" || nameOf(instance.scope) !== label) {
          continue;
        }
      } catch {
        continue;
      }
      // The most specific first: the path entered itself, then the longest base, then the
      // latest to end.
      const rank = session.p === pathname ? Number.MAX_SAFE_INTEGER : (base?.length ?? 0);
      if (
        best === null ||
        rank > best.rank ||
        (rank === best.rank && session.x > best.access.expiresAt)
      ) {
        const origin = originOfLabel(label);
        best = {
          rank,
          access: {
            instance,
            viewer: session.w,
            origin,
            expiresAt: session.x,
            ...(session.a === 1 ? { anonymous: true } : {}),
            ...(typeof session.s === "string" ? { subject: session.s } : {}),
          },
          ...(base !== null && under
            ? {
                at: {
                  base,
                  rest: pathname.slice(base.length),
                  search: url.search,
                  pinned: session.k === 1,
                  source: new URL(base, origin).href,
                },
              }
            : {}),
          ...(base !== null && atBase && session.p !== pathname
            ? { redirect: `${origin}${base}${url.search}` }
            : {}),
        };
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
      return nameOf(instance.scope) === label ? { ...record, instance } : null;
    } catch {
      return null;
    }
  }

  function documentHeaders(
    csp: string,
    permissions: string | null,
    ancestors: string = frameAncestors,
  ): Headers {
    return new Headers({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `${csp}; frame-ancestors ${ancestors}`,
      // What the frame's `allow` doesn't grant, denied on a tab of its own too (P099).
      ...(permissions === null ? {} : { "permissions-policy": permissions }),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    });
  }

  /**
   * The access a sealed files' address carries (P083), if it holds for this origin now: on its own
   * for its hour (`x`), then only for the running page's own loads until the session ends (`e`).
   */
  async function sealedAccess(
    request: Request,
    label: string,
    token: string,
  ): Promise<Access | null> {
    const session = await keys.unseal(token);
    const now = Date.now();
    if (
      !isRecord(session) ||
      typeof session.w !== "string" ||
      typeof session.x !== "number" ||
      typeof session.e !== "number" ||
      (session.s !== undefined && typeof session.s !== "string")
    ) {
      return null;
    }
    const open = session.x > now || (session.e > now && ownLoad(request));
    let instance: InstanceRef;
    try {
      instance = cleanInstance(session.i);
    } catch {
      return null;
    }
    if (!open || instance.document.kind !== "artifact" || nameOf(instance.scope) !== label) {
      return null;
    }
    return {
      instance,
      viewer: session.w,
      origin: originOfLabel(label),
      expiresAt: session.e,
      ...(session.a === 1 ? { anonymous: true } : {}),
      ...(typeof session.s === "string" ? { subject: session.s } : {}),
    };
  }

  /**
   * A file set's file in a frame (P083): the sealed access in its path opens it, once it holds
   * for this origin and the host's check lets it in; every path under it is the same version's.
   */
  /** A files' address for an access (P083): sealed, its own end within the session's. */
  async function sealFiles(
    access: Access,
  ): Promise<{ readonly base: string; readonly expires: number }> {
    const expires = Math.min(access.expiresAt, Date.now() + FILES_ADDRESS_MS);
    const token = await keys.seal({
      i: access.instance,
      w: access.viewer,
      x: expires,
      e: access.expiresAt,
      ...(access.anonymous === true ? { a: 1 } : {}),
      ...(access.subject === undefined ? {} : { s: access.subject }),
    });
    return { base: `${FILES_PREFIX}${token}/`, expires };
  }

  /**
   * A file set's file in a frame (P083): the sealed access in its path opens it, once it holds
   * for this origin and the host's check lets it in; every path under it is the same version's.
   * The address opens on its own for an hour (its `x`); after that, until the session's end (its
   * `e`), only the running page's own loads (same-origin, not a navigation), from addresses it
   * already holds, while its shell renews the address (`__porthole/renew`).
   */
  async function serveSealed(
    request: Request,
    url: URL,
    label: string,
    token: string,
    rest: string | undefined,
  ): Promise<Response> {
    const method = request.method.toUpperCase();
    const origin = originOfLabel(label);
    const base = `${FILES_PREFIX}${token}/`;
    if (rest === undefined) {
      return new Response(null, {
        status: 307,
        headers: { location: `${origin}${base}${url.search}`, "cache-control": "no-store" },
      });
    }
    const access = await sealedAccess(request, label, token);
    if (access === null) {
      // In a nested page's frame (P111) its shell frames it and hears it, on this origin; a
      // config without nesting never frames this address but at the host.
      return statusPage(
        401,
        "This has ended",
        "Content here opens for a while. Open it again from the app that showed it.",
        nestedAncestors(origin, frameAncestors),
        method,
        "session",
        [...options.hostOrigins, origin],
      );
    }
    // An asset of this artifact's library, at the frame's own sealed address (P091): every engine
    // sends a frame's path, where some send no Referer that names it.
    const blob = SEALED_ASSET.exec(rest)?.[1];
    if (blob !== undefined) {
      if (options.assets === undefined) {
        return page(404, "Not found", "This address names no content.", method);
      }
      return (
        (await assetFor(request, label, access, blob)) ??
        page(404, "Not found", "This address names no content.", method)
      );
    }
    if (rest === RENEW_PATH) {
      // Only the page itself renews its address, while its session lasts and the host lets it.
      if (method !== "GET" || !ownLoad(request)) {
        return page(403, "Not allowed", "Only the page renews its own address.", method);
      }
      const refusal = await denied(request, access);
      if (refusal !== null) {
        return refusal;
      }
      const renewed = await sealFiles(access);
      return Response.json(
        { base: `${origin}${renewed.base}`, expires: renewed.expires },
        {
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "cross-origin-resource-policy": "same-origin",
            "content-security-policy": `${INERT_FILE_CSP}; frame-ancestors ${frameAncestors}`,
            "referrer-policy": "no-referrer",
          },
        },
      );
    }
    return serveAccess(request, access, null, {
      base,
      rest: rest.slice(1),
      search: url.search,
      pinned: true,
      // Every frame's files on this origin share the prefix (the scope's, P082): a page knows
      // only its own access.
      source: `${origin}${FILES_PREFIX}`,
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
        ...(record.anonymous === true ? { anonymous: true } : {}),
        ...(record.subject === undefined ? {} : { subject: record.subject }),
      };
    }
    access ??= accessOf(request, label, key);
    if (access === null) {
      return page(
        401,
        "This link has been used",
        "Content here opens once per link. Open it again from the app that showed it.",
        method,
        "session",
      );
    }
    return serveAccess(request, access, cookie);
  }

  /**
   * The document an access opens, once the host's check lets it in: at its document's path, or
   * (`at`) a path under a file set's base (P081).
   */
  async function serveAccess(
    request: Request,
    access: Access,
    cookie: string | null,
    at?: FilesAt,
  ): Promise<Response> {
    const method = request.method.toUpperCase();
    const refusal = await denied(request, access);
    if (refusal !== null) {
      return refusal;
    }
    const served = await documentOf(access.instance);
    if (served === null) {
      return page(404, "Not found", "This page, or this version of it, doesn't exist.", method);
    }
    // A nested page (P111): the address the host frames (a ticket's, a cookie's, an entered
    // one's) answers Porthole's shell, which frames the page at its sealed files' address; only
    // that address, below the sealed prefix, answers the page and its files, without a cookie.
    const nested = served.compiled.config.nested === true;
    const sealedAt = at !== undefined && at.base.startsWith(FILES_PREFIX);
    if (nested && !sealedAt) {
      if (!isNavigation(request)) {
        return page(404, "Not found", "This page's files are at its own address.", method);
      }
      const sealed = await sealFiles(access);
      let rest = "";
      if ("files" in served) {
        const entry = served.files.entry ?? DEFAULT_ENTRY;
        rest =
          at !== undefined && at.rest !== ""
            ? at.rest
            : entry.includes("/")
              ? entry
                  .split("/")
                  .map((segment) => encodeURIComponent(segment))
                  .join("/")
              : "";
      }
      const shell = nestedShellResponse(served.compiled, {
        origin: access.origin,
        origins: options.hostOrigins,
        page: `${access.origin}${sealed.base}${rest}`,
        renew: { url: `${access.origin}${sealed.base}__porthole/renew`, expires: sealed.expires },
        method,
      });
      if (cookie !== null) {
        shell.headers.set("set-cookie", cookie);
      }
      return shell;
    }
    // Below the sealed prefix, a nested page and its files are framed by its shell too.
    const ancestors = nested ? nestedAncestors(access.origin, frameAncestors) : frameAncestors;
    if ("files" in served) {
      if (at !== undefined) {
        return serveFile({
          request,
          set: served.files,
          rest: at.rest,
          search: at.search,
          base: at.base,
          origin: access.origin,
          pinned: at.pinned,
          source: at.source,
          compiled: served.compiled,
          hostOrigins: options.hostOrigins,
          frameAncestors: ancestors,
          ...versionOf(access.instance),
        });
      }
      // A frame's document (a ticket's): its files carry its access in their path (P083). The
      // entry comes in the ticket's own answer (P025), its shell moving the frame to its address
      // there before anything loads, and renewing it before it ends.
      const sealed = await sealFiles(access);
      return serveFile({
        request,
        set: served.files,
        rest: "",
        search: "",
        base: sealed.base,
        origin: access.origin,
        pinned: true,
        source: `${access.origin}${FILES_PREFIX}`,
        compiled: served.compiled,
        hostOrigins: options.hostOrigins,
        frameAncestors,
        ticket: { expires: sealed.expires },
        ...versionOf(access.instance),
      });
    }
    // One page at a file set's base (P081): its base is the page, nothing under it is.
    if (at !== undefined && at.rest !== "") {
      return page(404, "Not found", "This page, or this version of it, doesn't exist.", method);
    }
    // A page that may use its artifact's assets loads them from its own origin (P089); every
    // served page carries its frame's sandbox, a tab of its own included (P099).
    const { config, cspDirectives } = served.compiled;
    const headers = documentHeaders(
      servedDocumentCsp(
        config,
        served.assets ? assetCspDirectives(config, cspDirectives, access.origin) : cspDirectives,
      ),
      servedPermissionsPolicy(config),
      ancestors,
    );
    if (cookie !== null) {
      headers.set("set-cookie", cookie);
    }
    // A nested page's document takes messages from its shell, on its own origin (P111).
    const html = nested
      ? served.compiled.shellDocument({
          origins: [access.origin],
          document: served.document ?? "",
          cspMeta: false,
        })
      : served.html;
    return new Response(method === "HEAD" ? null : html, { status: 200, headers });
  }

  /**
   * An asset at `/_blob/<id>` (P089, after the review): a request carrying an access to an
   * artifact of this origin (its page's sealed files' address, as its `Referer` says, P091; or a
   * session cookie), then the host's check for that access, then the host's store asked with it;
   * served only when the asset is that artifact's, on its scope's origin. Never an entry. By id
   * alone only where the host opted into it (`assets.bearer`).
   */
  async function serveAssetAt(request: Request, label: string, id: string): Promise<Response> {
    const method = request.method.toUpperCase();
    const store = options.assets;
    const none = () => page(404, "Not found", "This address names no content.", method);
    if (store === undefined) {
      return none();
    }
    const scoped = (asset: StoredAsset | null): asset is StoredAsset => {
      try {
        return asset !== null && nameOf(asset.scope) === label;
      } catch {
        return false;
      }
    };
    if (store.bearer === true) {
      const asset = await store.get(id, null);
      return scoped(asset)
        ? serveAsset({ request, asset, frameAncestors, code: runsAsCode(asset, null) })
        : none();
    }
    const accesses = await assetAccessesOf(request, label);
    if (accesses.length === 0) {
      return new Response(null, { status: 401, headers: { "cache-control": "no-store" } });
    }
    for (const access of accesses) {
      const answer = await assetFor(request, label, access, id);
      if (answer !== null) {
        return answer;
      }
    }
    return none();
  }

  /**
   * An asset for one access (P089, P091): the store asked with it, served only when the asset is
   * its artifact's on its scope's origin, after the host's check; its code only where it was
   * trusted and the artifact's config still lets uploaded code run. Null: not this access's.
   */
  async function assetFor(
    request: Request,
    label: string,
    access: Access,
    id: string,
  ): Promise<Response | null> {
    const store = options.assets;
    if (store === undefined || access.instance.document.kind !== "artifact") {
      return null;
    }
    const asset = await store.get(id, access);
    let named: string | null = null;
    try {
      named = asset === null ? null : nameOf(asset.scope);
    } catch {
      named = null;
    }
    if (asset === null || named !== label || asset.artifact !== access.instance.document.id) {
      return null;
    }
    const refusal = await denied(request, access);
    if (refusal !== null) {
      return refusal;
    }
    return serveAsset({ request, asset, frameAncestors, code: runsAsCode(asset, access) });
  }

  /**
   * Whether a code-typed asset goes out as code (P089, P103): only where it was trusted when it
   * was uploaded and the config its artifact's page is served under still lets uploaded code
   * run, asked at every request, so a stricter config wins at once. An access names that config.
   * By id alone (bearer mode) the server can't tell which of its artifact configs the page is
   * under: the strictest it might be decides (every one must let uploaded code run).
   */
  function runsAsCode(asset: StoredAsset, access: Access | null): boolean {
    if (asset.trusted !== true) {
      return false;
    }
    if (access !== null) {
      const config = compiledFor(access.instance)?.config;
      return config !== undefined && assetCodeRuns(config);
    }
    const artifacts = [...compiled.values()]
      .map((each) => each.config)
      .filter((config) => config.mode === "artifact" && config.isolation === "domain");
    return artifacts.length > 0 && artifacts.every((config) => assetCodeRuns(config));
  }

  /**
   * The accesses a request carries to artifacts of `label`'s origin, most specific first: the
   * sealed files' address its page is at (a frame's, which keeps no cookie, P083), as its
   * same-origin `Referer` names it; then its session cookies.
   */
  async function assetAccessesOf(request: Request, label: string): Promise<Access[]> {
    const found: Access[] = [];
    const referer = request.headers.get("referer");
    if (referer !== null) {
      try {
        const from = new URL(referer);
        const token = FILES_PATH.exec(from.pathname)?.[1];
        if (from.origin === originOfLabel(label) && token !== undefined) {
          const sealed = await sealedAccess(request, label, token);
          if (sealed !== null) {
            found.push(sealed);
          }
        }
      } catch {
        // Not an address: no access from it.
      }
    }
    return [...found, ...artifactAccessesOf(request, label)];
  }

  /** The accesses a request's cookies give to artifacts of `label`'s origin, latest first. */
  function artifactAccessesOf(request: Request, label: string): Access[] {
    const found: Access[] = [];
    for (const [name, value] of cookiesOf(request)) {
      if (!ourCookie(name)) {
        continue;
      }
      const session = keys.verify(value);
      if (
        !isRecord(session) ||
        typeof session.w !== "string" ||
        typeof session.x !== "number" ||
        session.x <= Date.now() ||
        (session.s !== undefined && typeof session.s !== "string")
      ) {
        continue;
      }
      let instance: InstanceRef;
      try {
        instance = cleanInstance(session.i);
        if (instance.document.kind !== "artifact" || nameOf(instance.scope) !== label) {
          continue;
        }
      } catch {
        continue;
      }
      found.push({
        instance,
        viewer: session.w,
        origin: originOfLabel(label),
        expiresAt: session.x,
        ...(session.a === 1 ? { anonymous: true } : {}),
        ...(typeof session.s === "string" ? { subject: session.s } : {}),
      });
    }
    return found.sort((a, b) => b.expiresAt - a.expiresAt);
  }

  /**
   * A clean address without a cookie for it (P068): off to the host's authorize route with a
   * signed state, the browser holding the state's nonce in a cookie of this origin. A path just
   * entered whose cookie still didn't come back is a browser that keeps none here: no loop.
   */
  async function beginEntry(request: Request, url: URL, label: string, to: URL): Promise<Response> {
    const method = request.method.toUpperCase();
    // An address that names nothing is nothing here (P070): never a trip to the app's sign-in.
    const scopeOf = content.name?.scopeOf;
    const named = options.entry?.named;
    if (
      (scopeOf !== undefined && scopeOf(label) === null) ||
      (named !== undefined && !(await named(label, url.pathname, request)))
    ) {
      return page(404, "Nothing here", "This address names no content.", method);
    }
    // Only a page opening is sent to sign in (a browser's navigation; a client that sends no fetch
    // metadata may be one): a browser's subresource without a session is refused here, with no
    // state of its own (no nonce cookie, nothing cached).
    const mode = request.headers.get("sec-fetch-mode");
    const dest = request.headers.get("sec-fetch-dest") ?? "";
    if (mode !== null && mode !== "navigate" && !["document", "iframe", "frame"].includes(dest)) {
      return new Response(method === "HEAD" ? null : "Open this address in a browser.", {
        status: 401,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }
    if (method !== "GET" && method !== "HEAD") {
      return page(
        401,
        "Open this from the app",
        "Open this address in a browser.",
        method,
        "session",
      );
    }
    const path = `${url.pathname}${url.search}`;
    if (path.length > MAX_PATH) {
      return page(414, "Address too long", "This address is too long to open.", method);
    }
    const mark = enteredMark(label, url.pathname);
    const marked = cookieName("n-");
    if (cookiesOf(request).some(([name, value]) => name.startsWith(marked) && value === mark)) {
      return page(
        401,
        "Open this in a new tab",
        "This browser keeps no sign-in for it inside a frame.",
        method,
        "cookies",
      );
    }
    const nonce = base32(randomBytes(10));
    const framed = request.headers.get("sec-fetch-dest") !== "document";
    const state = keys.sign({
      e: 1,
      l: label,
      p: path,
      n: nonce,
      x: Date.now() + ENTRY_STATE_MS,
      f: framed ? 1 : 0,
    });
    const location = new URL(to);
    location.searchParams.set("state", state);
    return new Response(null, {
      status: 302,
      headers: {
        location: location.href,
        "set-cookie": [
          `${nonceCookie(nonce)}=1`,
          "Path=/",
          "HttpOnly",
          `Max-Age=${ENTRY_STATE_MS / 1_000}`,
          ...cookieContext(request),
        ].join("; "),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  /**
   * Redeems a redirect entry's code (P068): once, on its own label, in the browser that began it
   * (its nonce cookie comes with it). Sets the session and goes to the clean address, the code
   * gone from the address bar and from any referrer.
   */
  async function redeem(request: Request, url: URL, label: string): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method !== "GET") {
      return page(405, "Not allowed", "Open this link in a browser.", method);
    }
    const record = await take(url.searchParams.get("code"), label);
    if (record?.entry === undefined) {
      return page(
        403,
        "This sign-in link has been used",
        "It works once, for a short time. Open the address again.",
        method,
        "session",
      );
    }
    const { nonce, path, base, pinned } = record.entry;
    const named = nonceCookie(nonce);
    if (!cookiesOf(request).some(([name, value]) => name === named && value === "1")) {
      return page(
        401,
        "Open this in a new tab",
        "This browser keeps no sign-in for it inside a frame.",
        method,
        "cookies",
      );
    }
    const origin = originOfLabel(label);
    const target = new URL(path, origin);
    const access: Access = {
      instance: record.instance,
      viewer: record.viewer,
      origin,
      expiresAt: Date.now() + (record.sessionSeconds ?? DEFAULT_SESSION_SECONDS) * 1_000,
      ...(record.anonymous === true ? { anonymous: true } : {}),
      ...(record.subject === undefined ? {} : { subject: record.subject }),
    };
    const refusal = await denied(request, access);
    if (refusal !== null) {
      return refusal;
    }
    const external = record.instance.document.kind === "external";
    const headers = new Headers({
      location: `${origin}${target.pathname}${target.search}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    });
    // A file set's address (P081): the session serves every path under its base, the version's
    // own address. Else the path it was entered at, alone (P068).
    headers.append(
      "set-cookie",
      sessionCookie(
        request,
        record,
        external
          ? {}
          : base !== undefined
            ? { b: base, ...(pinned === true ? { k: 1 as const } : {}) }
            : { p: target.pathname },
      ),
    );
    headers.append(
      "set-cookie",
      [
        `${named}=${enteredMark(label, target.pathname)}`,
        "Path=/",
        "HttpOnly",
        `Max-Age=${ENTERED_SECONDS}`,
        ...cookieContext(request),
      ].join("; "),
    );
    return new Response(null, { status: 303, headers });
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
        method,
        "session",
      );
    }
    const refusal = await denied(request, {
      instance: record.instance,
      viewer: record.viewer,
      origin: originOfLabel(label),
      expiresAt: record.expiresAt,
      ...(record.subject === undefined ? {} : { subject: record.subject }),
    });
    if (refusal !== null) {
      return refusal;
    }
    const target = new URL(record.instance.document.url);
    const landing = `${target.pathname}${target.search}${target.hash}`;
    // In a frame, a page enters the app: it can tell whether the browser kept the cookie (and tell
    // the host), where a redirect would leave a frame without one showing a refusal. On a tab of
    // its own, a redirect.
    if (request.headers.get("sec-fetch-dest") !== "document") {
      return enterPage(
        landing,
        frameAncestors,
        options.hostOrigins,
        sessionCookie(request, record),
      );
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: landing,
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
      .filter(([name]) => !isPortholeCookie(name))
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
      if (!setsPortholeCookie(cookie)) {
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
    // Before the cookie is read: another origin's request is refused whatever it carries.
    if (!fromItsOwnOrigin(request, label, true)) {
      return page(
        403,
        "Not from this app",
        "A request from another site doesn't ride this app's sign-in.",
        method,
      );
    }
    const access = accessOf(request, label, null);
    if (access === null) {
      return page(
        401,
        "Open this from the app",
        "This address shows an app only to the people the app opens it for.",
        method,
        "session",
      );
    }
    const refusal = await denied(request, access);
    if (refusal !== null) {
      return refusal;
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

  /** A one-time ticket (or entry code) for an instance the host decided a viewer may see. */
  async function mint(
    instance: InstanceRef,
    grant: Grant,
    entry?: TicketRecord["entry"],
  ): Promise<{ readonly clean: InstanceRef; readonly key: string; readonly ticket: string }> {
    const clean = cleanInstance(instance);
    check(clean);
    const anonymous = grant.anonymous === true;
    if (anonymous) {
      if (grant.viewer !== undefined) {
        throw new TypeError("An anonymous grant names no viewer");
      }
      if (clean.document.kind === "external") {
        throw new TypeError("A url-mode app is never opened anonymously (P046)");
      }
    } else if (
      typeof grant.viewer !== "string" ||
      grant.viewer.length === 0 ||
      grant.viewer.length > 512
    ) {
      throw new TypeError("A grant's viewer is 1 to 512 characters (or the grant is anonymous)");
    }
    if (
      grant.subject !== undefined &&
      (typeof grant.subject !== "string" || grant.subject.length > SUBJECT_MAX)
    ) {
      throw new TypeError(`A grant's subject is a string of at most ${SUBJECT_MAX} characters`);
    }
    const ttl = seconds(grant.ttlSeconds, DEFAULT_TICKET_SECONDS, MAX_TICKET_SECONDS, "ttlSeconds");
    const sessionSeconds = seconds(
      grant.sessionSeconds,
      DEFAULT_SESSION_SECONDS,
      MAX_SESSION_SECONDS,
      "sessionSeconds",
    );
    const key = keys.instanceKey(clean);
    const viewer = anonymous ? "" : grant.viewer;
    const probe = keys.sign({
      i: clean,
      w: viewer,
      x: Number.MAX_SAFE_INTEGER,
      ...(anonymous ? { a: 1 } : {}),
      ...(grant.subject === undefined ? {} : { s: grant.subject }),
      ...(entry === undefined ? {} : { p: entry.path }),
      ...(entry?.base === undefined
        ? {}
        : { b: entry.base, ...(entry.pinned === true ? { k: 1 } : {}) }),
    });
    if (cookieName(key).length + probe.length + 120 > MAX_COOKIE_BYTES) {
      throw new TypeError("This instance is too large to carry in a cookie (fewer origins?)");
    }
    const ticket = newTicket();
    await tickets.put(ticketId(ticket), {
      instance: clean,
      viewer,
      expiresAt: Date.now() + ttl * 1_000,
      ...(grant.sessionSeconds === undefined ? {} : { sessionSeconds }),
      ...(anonymous ? { anonymous: true } : {}),
      ...(grant.subject === undefined ? {} : { subject: grant.subject }),
      ...(entry === undefined ? {} : { entry }),
    });
    return { clean, key, ticket };
  }

  const underDomain = (host: string): boolean => host === domain || host.endsWith(`.${domain}`);

  /**
   * The label a request is for: null when it isn't under the content domain at all (or is in a
   * reserved namespace), "mismatch" when its Host header names another host than its URL does
   * and either is under the content domain. A Node adapter may build the URL from an
   * absolute-form request target (`GET http://other/…`) while a host routes by the Host header
   * (and a cache keys on it): the two must agree before anything is served. A Host that is a
   * local server address (an IP literal, `localhost`), as a test runner or a dev proxy sends, is
   * not a name and isn't compared.
   */
  function labelOf(
    request: Request,
  ): { readonly url: URL; readonly label: string } | "mismatch" | null {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    const header = request.headers.get("host");
    if (header !== null) {
      const named = normalHost(header, url.protocol);
      const name = named.replace(/:\d+$/u, "");
      const local = name === "localhost" || /^[\d.]+$/u.test(name) || name.startsWith("[");
      if (
        !local &&
        named !== normalHost(url.host, url.protocol) &&
        (underDomain(host) || underDomain(name))
      ) {
        return "mismatch";
      }
    }
    if (!underDomain(host)) {
      return null;
    }
    const label = host.slice(0, Math.max(0, host.length - domain.length - 1));
    // A reserved label is another server's namespace (`f` for `<x>.f.<domain>`), or the host's
    // own: it and the names under it go to the host's own routes. Any other deeper name is ours
    // to refuse.
    if (isReserved(label.split(".").at(-1) ?? "")) {
      return null;
    }
    return { url, label };
  }

  return {
    contentSource,

    originFor: (scope) => originOfLabel(nameOf(scope)),

    async issue(instance, grant): Promise<FrameLocation> {
      const { clean, key, ticket } = await mint(instance, grant);
      const origin = originOfLabel(nameOf(clean.scope));
      const path =
        clean.document.kind === "external"
          ? `${ENTER_PATH}?ticket=${ticket}`
          : `${PREFIX}d/${key}?ticket=${ticket}`;
      // The viewer's level, as the host's access decided it now (P087): for the display's bridge.
      const viewer = viewerOfGrant(grant);
      return { url: `${origin}${path}`, origin, reports: true, ...(viewer ? { viewer } : {}) };
    },

    forget(filter = {}) {
      for (const [key, each] of answers) {
        if (
          (filter.scope === undefined || each.scope === filter.scope) &&
          (filter.subject === undefined || each.subject === filter.subject)
        ) {
          answers.delete(key);
        }
      }
    },

    urlOf(scope, path = "/") {
      if (!path.startsWith("/") || path.startsWith("//") || path.startsWith(PREFIX)) {
        throw new TypeError("A clean address's path starts with one / and isn't Porthole's own");
      }
      return `${originOfLabel(nameOf(scope))}${path}`;
    },

    entryState(token) {
      const state = token.length > 8_192 ? null : keys.verify(token);
      if (
        !isRecord(state) ||
        state.e !== 1 ||
        typeof state.l !== "string" ||
        !ours(state.l) ||
        typeof state.p !== "string" ||
        !state.p.startsWith("/") ||
        typeof state.n !== "string" ||
        !NONCE.test(state.n) ||
        typeof state.x !== "number" ||
        (state.f !== 0 && state.f !== 1)
      ) {
        return null;
      }
      return {
        label: state.l,
        path: state.p,
        nonce: state.n,
        framed: state.f === 1,
        expired: state.x <= Date.now(),
      };
    },

    async enterBy(state, instance, grant, address): Promise<string> {
      if (state.expired) {
        throw new TypeError("This entry's state has expired: start again from the clean address");
      }
      const clean = cleanInstance(instance);
      if (nameOf(clean.scope) !== state.label) {
        throw new TypeError("The instance isn't served on the address the entry began at");
      }
      let path = state.path;
      if (address !== undefined) {
        // A file set's own address (P081): a path ending in /, not Porthole's own. An address
        // that isn't under it (the latest's) goes to the same file under it, which must stay
        // under it: no dot segment, no backslash, nothing the URL parser would resolve away.
        const { base, file = "" } = address;
        const segments = typeof file === "string" ? file.split("/") : [];
        if (
          typeof base !== "string" ||
          !BASE.test(base) ||
          base.startsWith(PREFIX) ||
          typeof file !== "string" ||
          file.length > MAX_PATH ||
          file.startsWith("/") ||
          // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
          /[?#\\\u0000-\u001f\u007f]/u.test(file) ||
          segments.some((each) => /^(?:\.|%2e){1,2}$/iu.test(each))
        ) {
          throw new TypeError(
            "An entry's base is a path ending in / (not Porthole's own), its file a relative path below it",
          );
        }
        const asked = new URL(state.path, "https://x.invalid");
        if (!asked.pathname.startsWith(base)) {
          path = `${base}${file}${asked.search}`;
        }
        if (!new URL(path, "https://x.invalid").pathname.startsWith(base)) {
          throw new TypeError("An entry's file must stay below its base");
        }
      }
      const { ticket } = await mint(
        clean,
        { ...grant, ttlSeconds: ENTRY_CODE_SECONDS },
        {
          path,
          nonce: state.nonce,
          ...(address === undefined
            ? {}
            : { base: address.base, ...(address.pinned === true ? { pinned: true } : {}) }),
        },
      );
      return `${originOfLabel(state.label)}${ENTRY_PATH}?code=${ticket}`;
    },

    async access(request) {
      const at = labelOf(request);
      // A socket is never a navigation: the app's own origin only (P101).
      if (
        at === null ||
        at === "mismatch" ||
        !ours(at.label) ||
        !fromItsOwnOrigin(request, at.label, false)
      ) {
        return null;
      }
      const access = accessOf(request, at.label, null);
      return access === null || (await denied(request, access)) !== null ? null : access;
    },

    async handle(request) {
      const at = labelOf(request);
      if (at === null) {
        return null;
      }
      const method = request.method.toUpperCase();
      if (at === "mismatch") {
        return page(
          400,
          "Bad request",
          "The request's Host header and its URL name different hosts.",
          method,
        );
      }
      const { url, label } = at;
      try {
        if (!ours(label)) {
          return page(404, "Nothing here", "This address names no content.", method);
        }
        if (url.pathname === ENTER_PATH) {
          return await enter(request, url, label);
        }
        if (url.pathname === ENTRY_PATH && authorizeUrl !== null) {
          return await redeem(request, url, label);
        }
        const script = pageScript(url.pathname) ?? libraryFile(url.pathname, method);
        if (script !== null) {
          return script;
        }
        if (url.pathname === SESSION_PATH) {
          // Whether this request's cookie opens its origin's app: the entry page asks, from the
          // app's origin (P101).
          if (!fromItsOwnOrigin(request, label, false)) {
            return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
          }
          const access = accessOf(request, label, null);
          const status =
            access === null ? 401 : (await denied(request, access)) === null ? 204 : 403;
          return new Response(null, { status, headers: { "cache-control": "no-store" } });
        }
        // An artifact's asset library (P089), outside every version: `/_blob/<id>` only; any
        // other path there is a clean address as before (after the review).
        const asset = options.assets === undefined ? null : ASSET_ROUTE.exec(url.pathname);
        if (asset?.[1] !== undefined) {
          return await serveAssetAt(request, label, asset[1]);
        }
        const document = DOCUMENT_PATH.exec(url.pathname);
        if (document?.[1] !== undefined) {
          return await serveDocument(request, url, label, document[1]);
        }
        const sealed = FILES_PATH.exec(url.pathname);
        if (sealed?.[1] !== undefined) {
          return await serveSealed(request, url, label, sealed[1], sealed[2]);
        }
        if (url.pathname.startsWith(PREFIX)) {
          return page(404, "Nothing here", "This address names no content.", method);
        }
        // A clean address (P068): the document entered here, else the app, else entry.
        if (authorizeUrl !== null) {
          const entered = accessAtPath(request, label, url);
          if (entered?.redirect !== undefined) {
            return new Response(null, {
              status: 307,
              headers: { location: entered.redirect, "cache-control": "no-store" },
            });
          }
          if (entered !== null) {
            return await serveAccess(request, entered.access, null, entered.at);
          }
          if (options.upstream === undefined || accessOf(request, label, null) === null) {
            return await beginEntry(request, url, label, authorizeUrl);
          }
        }
        // Without an upstream, only Porthole's own paths are served here: any other is nothing.
        if (options.upstream === undefined) {
          return page(404, "Nothing here", "This address names no content.", method);
        }
        return await serveApp(request, label);
      } catch {
        return page(500, "Something went wrong", "This content couldn't be served.", method);
      }
    },
  };
}
