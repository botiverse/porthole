import type { PortholeConfig } from "../config/schema.ts";
import { embedderFrameSourcesOf } from "../compile/policy.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";
import type { Displays } from "../displays/displays.ts";
import type { ContentClientMeta } from "../host/client.ts";
import { base64url, fromBase64url, fromUtf8, hmacSha256, timingSafeEqual, utf8 } from "./crypto.ts";
import {
  ContentDomainError,
  contentDomain,
  serverDomain,
  type ContentDomainInfo,
} from "./domain.ts";
import { reservedLabels, type Naming } from "./naming.ts";
import { appStatusPage } from "./pages.ts";
import { createServer } from "./server.ts";
import type {
  Access,
  ArtifactStore,
  AuthorizeAnswer,
  AuthorizeRequest,
  Grant,
  PortholeServer,
  TicketStore,
  Upstream,
} from "./types.ts";

/**
 * The host kit (P066): everything around `/server` that every host wrote, so an app writes only
 * its policy (four callbacks) and its settings. Web-standard and runtime-agnostic: Node (through
 * `@botiverse/porthole/node`), Cloudflare Workers, Deno, Bun.
 */

/** Where Porthole answers its health check, on the health label. */
export const HEALTH_PATH = "/__porthole/health";
const DEFAULT_HEALTH_LABEL = "porthole-health";
const PROBE_TIMEOUT_MS = 10_000;
const UNHEALTHY_EVERY_MS = 60_000;
const HEALTHY_EVERY_MS = 600_000;

/** What the health check's answer is fetched with: Node's needs `*.localhost` on loopback. */
export type HealthProbe = (
  url: string,
  timeoutMs: number,
) => Promise<{ readonly status: number; readonly body: string }>;

export interface HealthOptions {
  /** The label Porthole answers its health check on (reserved from naming). */
  readonly label?: string;
  /** How the check is fetched (default: `fetch`; on Node, `nodeProbe()`). */
  readonly probe?: HealthProbe;
  readonly timeoutMs?: number;
  /**
   * Told each time the gate's state changes (P070): checking to healthy or unhealthy, and every
   * flip between them, with the new view. `meta().served` changes with it, so an app that tells
   * its clients whether frames are served pushes it from here.
   */
  readonly onChange?: (view: ContentHealthView) => void;
  /**
   * Told when frames start or stop being served (P072): `meta().served` flipped. Deduplicated:
   * once per flip, not per check.
   */
  readonly onServedChange?: (served: boolean) => void;
}

/** Where content stands, for the app's own meta and logs. */
export interface ContentHealthView {
  /** `off`: no content domain. `checking`: the first check hasn't answered yet. */
  readonly state: "off" | "checking" | "healthy" | "unhealthy";
  readonly reason?: string;
  /** Set when the settings can't be served at all: it never changes until they do. */
  readonly misconfigured?: true;
  readonly checkedAt?: number;
}

/** What the kit tells the app's log, by a stable `evt` name. */
export type ContentHostEvent =
  | {
      readonly evt: "porthole.content.misconfigured";
      readonly code: string;
      readonly reason: string;
    }
  | { readonly evt: "porthole.content.healthy" }
  | { readonly evt: "porthole.content.unhealthy"; readonly reason: string };

/** What the app's page needs: whether frames are served, from where, and the gate's state. */
export interface ContentMeta {
  readonly served: boolean;
  readonly contentSource: string | null;
  readonly health: ContentHealthView | null;
}

export type { ContentClientMeta } from "../host/client.ts";

/** A logger (pino, console, winston): the kit's events at their level (P072). */
export interface ContentLogger {
  readonly info?: (message: string, event: ContentHostEvent) => void;
  readonly warn?: (message: string, event: ContentHostEvent) => void;
  readonly error?: (message: string, event: ContentHostEvent) => void;
}

type Awaitable<T> = T | Promise<T>;

export interface ContentHostOptions<V> {
  /** `content.example.com`, `content.localhost:8790`; empty: content off. Or parsed settings. */
  readonly domain: string | null | undefined | ContentDomainInfo;
  /** The app's own origins: they frame content (`frame-ancestors`) and are checked for clashes. */
  readonly appOrigins: readonly string[];
  /** At least 32 random bytes (or a string of at least 32 bytes). */
  readonly secret: Uint8Array | string;
  readonly tickets?: TicketStore;
  /**
   * The configs content is served under, given the content source (`https://*.<domain>`). Or
   * `displays` (P072), which says it for every kind once.
   */
  readonly configs?:
    | Readonly<Record<string, PortholeConfig>>
    | ((source: string) => Readonly<Record<string, PortholeConfig>>);
  /** The app's display kinds (`defineDisplays`): their served configs, in place of `configs`. */
  readonly displays?: Displays;
  /**
   * Where `routes` answers on the app's origin (P072): `<prefix>/frames`, `/authorize`, `/meta`,
   * `/handoff`. Default `/porthole`.
   */
  readonly prefix?: string;
  /**
   * How a scope is named (`prefixedName("a-")`); default: keyed labels. Redirect entry needs one
   * that says which scope a label names (`prefixedName` does).
   */
  readonly name?: Naming;
  /**
   * Labels the app itself serves on the content domain, which `fetch` hands back (null) so the
   * app's own routes answer there: Ferry's `p-*` previews, another server's namespace it routes
   * on. Not for labels nothing should answer: a label the naming never makes, the bare domain
   * and an address `entry.at` says names nothing all get Porthole's 404, with nothing to list
   * (P070). The health label is reserved by the gate itself.
   */
  readonly reserved?: readonly string[] | ((label: string) => boolean);
  /**
   * Policy 1, mapping: the instance a request proposes (`{ instance }`), as the app means it,
   * or null (404). A proposal, never trusted: derive the scope from what it names (a session, a
   * version), check its fields, refuse the rest. The client never chooses an origin.
   */
  readonly instance: (
    proposal: InstanceRef,
    viewer: V | null,
    request: Request,
  ) => Awaitable<InstanceRef | null>;
  /** Policy 2, access at issue: may this viewer see it, and with what grant (null: 401/403). */
  readonly access: (
    instance: InstanceRef,
    viewer: V | null,
    request: Request,
  ) => Awaitable<Grant | null>;
  /** Policy 3, on every request after (P050): may this cookie still see it. */
  readonly authorize?: (request: AuthorizeRequest) => Awaitable<AuthorizeAnswer>;
  readonly authorizeTtlSeconds?: number;
  /** Policy 4, source: a stored page by id and version (artifact documents). */
  readonly source?: ArtifactStore["get"];
  readonly upstream?: Upstream;
  /**
   * The health gate, and with it the opaque fallback (P066): the kit checks the content domain
   * over the real network; while it doesn't answer, or can't be served at all (misconfigured),
   * frames aren't served and the app's displays run opaque. Absent: settings that can't be
   * served throw at startup.
   */
  readonly health?: HealthOptions;
  /** Issues per viewer (or address) per minute, in this process. */
  readonly rateLimit?: {
    readonly perMinute: number;
    readonly key?: (request: Request, viewer: V | null) => string;
  };
  /** The kit's events: a function, or a logger (`{ info, warn, error }`). */
  readonly log?: ((event: ContentHostEvent) => void) | ContentLogger;
  /**
   * Redirect entry (P068): clean addresses (`urlOf`) that open directly, in a new tab, on a
   * reload, from a bookmark or a link someone with access was sent. Without a cookie, the content
   * origin sends the browser to the app's `authorizeUrl` (`ContentHost.authorize`), which asks
   * `at` and `access` and sends it back with a one-time code.
   */
  readonly entry?: EntryOptions<V>;
}

export interface EntryOptions<V> {
  /**
   * The app's authorize route (`ContentHost.authorize`), an absolute URL on an app origin.
   * Default: `<first app origin><prefix>/authorize`, where `routes` answers it.
   */
  readonly authorizeUrl?: string;
  /**
   * Policy 1 for a clean address: the instance a scope's path means, or null/undefined: nothing
   * (404). The path is the address's pathname; its query rides along but never chooses the
   * instance. Asked twice: on the content origin, with no viewer, whether the address names
   * anything at all (nothing: Porthole's 404 there, never the app's sign-in, P070); then at the
   * authorize route with the viewer. Say what exists the same way for both; `access` says who
   * may see it.
   */
  readonly at: (
    scope: string,
    path: string,
    viewer: V | null,
    request: Request,
  ) => Awaitable<InstanceRef | null | undefined>;
  /**
   * The app's own sign-in, which comes back to `returnTo` (the authorize URL, as `authorizeUrl`
   * names the app, with the entry's state) once signed in.
   * Only ever on a tab: in a frame, the person is asked to open a new tab instead. `entry` is the
   * address being opened, decoded (P070).
   */
  readonly signIn?: (
    returnTo: string,
    request: Request,
    entry: EntryContext,
  ) => Awaitable<Response>;
  /**
   * A single-page app's sign-in route (P072): the default `signIn` sends the person there with
   * `?next=<authorize URL>`, and the app goes on to `next` once signed in (check it with
   * `entryTarget`).
   */
  readonly spa?: { readonly route: string };
  /**
   * The clean path of an instance (the reverse of `at`), or null: `issue` then answers its clean
   * address as `link` (P072), for "open in a new tab" and "copy link". It may look it up (a
   * promise, P074); where it fails, the frame comes without a link.
   */
  readonly pathOf?: (instance: InstanceRef, request: Request) => Awaitable<string | null>;
  /**
   * A viewer handoff, for an app whose page authenticates with a token rather than a cookie
   * (P072): `POST <prefix>/handoff`, made with the app's own credential, leaves a short-lived key
   * for its viewer in a cookie only the authorize route gets. `id` says who the viewer is (at
   * most 512 characters); `viewer` turns it back into the app's viewer, or null.
   */
  readonly handoff?: {
    readonly id: (viewer: V) => string;
    readonly viewer: (id: string, request: Request) => Awaitable<V | null>;
  };
  /**
   * The app's refusal page on a tab (a frame gets Porthole's plain one), for the address in
   * `entry`. Nothing (null, undefined): Porthole's own (P070).
   */
  readonly refusal?: (
    status: 403 | 404,
    request: Request,
    entry: EntryContext,
  ) => Awaitable<Response | null | undefined>;
}

/** The clean address a redirect entry is opening, as its authorize route decoded it (P070). */
export interface EntryContext {
  /** The address's label, and the scope it names (null: one the naming never makes). */
  readonly label: string;
  readonly scope: string | null;
  /** The path (and query) asked for. */
  readonly path: string;
  /** The clean address itself: where the person comes back to. */
  readonly url: string;
  /** The instance the path names for this viewer (`entry.at`), or null. */
  readonly instance: InstanceRef | null;
  /** Whether it was asked from a frame. */
  readonly framed: boolean;
}

export interface ContentHost<V> {
  /** The parsed content domain, or null (off, or unusable settings under the fallback). */
  readonly domain: ContentDomainInfo | null;
  /** The underlying server, or null when nothing is served. */
  readonly server: PortholeServer | null;
  /** The frame sources the app's page CSP must allow (`frame-src`). */
  readonly frameSources: readonly string[];
  /**
   * The routing middleware: an answer for every request under the content domain (the app never
   * answers there); null for the app's own hosts and its reserved labels.
   */
  fetch(request: Request): Promise<Response | null>;
  /**
   * Whether a request is the content domain's (`fetch` answers it): false for the app's own
   * hosts and its reserved labels. For a WebSocket upgrade, which `fetch` can't take.
   */
  owns(request: Request): boolean;
  /** The issue endpoint: POST `{ instance }` → 201 `FrameLocation`, as a fetch handler. */
  issue(
    viewerOf: (request: Request) => Awaitable<V | null>,
  ): (request: Request) => Promise<Response>;
  /** Whether frames are served now, from where, and the gate's state. */
  meta(): ContentMeta;
  /**
   * A scope's clean address (P068), for "open in a new tab", "copy link" and bookmarks: null while
   * nothing is served. Opens through redirect entry (`entry`); frames take tickets (`issue`).
   */
  urlOf(scope: string, path?: string): string | null;
  /** Where `routes` answers (`/porthole`). */
  readonly prefix: string;
  /**
   * The app's Porthole routes in one handler (P072): `POST <prefix>/frames` (`issue`), `GET
   * <prefix>/authorize`, `GET <prefix>/meta` (`clientMeta`), `POST`/`DELETE <prefix>/handoff`.
   * Null for any other request: the app's own routes.
   */
  routes(
    viewerOf: (request: Request) => Awaitable<V | null>,
  ): (request: Request) => Promise<Response | null>;
  /** What `GET <prefix>/meta` answers the page. */
  clientMeta(): ContentClientMeta;
  /** The viewer handoff (`entry.handoff`), as a fetch handler: POST sets it, DELETE clears it. */
  handoff(
    viewerOf: (request: Request) => Awaitable<V | null>,
  ): (request: Request) => Promise<Response>;
  /** Drops cached `authorize` answers (`authorizeTtlSeconds`): all, or a scope's, or a subject's. */
  forget(filter?: { readonly scope?: string; readonly subject?: string }): void;
  /** The app's authorize route for redirect entry (`entry.authorizeUrl`), as a fetch handler. */
  authorize(
    viewerOf: (request: Request) => Awaitable<V | null>,
  ): (request: Request) => Promise<Response>;
  /** A url-mode app's access for a WebSocket upgrade (`server.access`), or null. */
  access(request: Request): Promise<Access | null>;
  /**
   * Starts the health gate (after the app listens). Once: starting a started host does nothing,
   * so the app and `nodeServer` may both start it (P076). After `close`, it starts again.
   */
  start(): void;
  /** Runs one health check now. */
  check(): Promise<ContentHealthView>;
  /** Stops the health gate. */
  close(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

const refusal = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

/** A plain page for the content domain's own refusals: never the app's. */
const plain = (status: number, text: string): Response =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });

type FrameBlockReason = Parameters<typeof appStatusPage>[4];

/** How long a viewer handoff holds (P072): the app's page refreshes it on load and focus. */
const HANDOFF_SECONDS = 600;

/** The kit's events to the app's `log`: its function, or its logger at each event's level. */
function logOf(given: ContentHostOptions<unknown>["log"]): (event: ContentHostEvent) => void {
  if (given === undefined) {
    return () => {};
  }
  if (typeof given === "function") {
    return given;
  }
  return (event) => {
    const message =
      event.evt === "porthole.content.healthy"
        ? "Porthole: the content domain answers; frames are served"
        : event.evt === "porthole.content.unhealthy"
          ? `Porthole: frames aren't served: ${event.reason}`
          : `Porthole: the content domain can't be served (${event.code}): ${event.reason}`;
    if (event.evt === "porthole.content.healthy") {
      given.info?.(message, event);
    } else if (event.evt === "porthole.content.unhealthy") {
      given.warn?.(message, event);
    } else {
      given.error?.(message, event);
    }
  };
}

/** The CSP source for an authorize route: its origin and path, so nothing else there frames. */
const authorizeSource = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
};

/** The default probe: the runtime's `fetch`, no redirects followed, a timeout. */
const fetchProbe: HealthProbe = async (url, timeoutMs) => {
  const response = await fetch(url, {
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.text()).slice(0, 4_096);
  return { status: response.status, body };
};

export function createContentHost<V>(options: ContentHostOptions<V>): ContentHost<V> {
  const gate = options.health;
  const log = logOf(options.log);
  const prefix = (options.prefix ?? "/porthole").replace(/\/+$/u, "");
  if (!/^\/[\w./-]*$/u.test(prefix)) {
    throw new TypeError("A route prefix is a path: /porthole");
  }
  const authorizeUrl =
    options.entry?.authorizeUrl ?? `${options.appOrigins[0] ?? ""}${prefix}/authorize`;
  if (options.configs === undefined && options.displays === undefined) {
    throw new TypeError("createContentHost needs configs or displays");
  }
  // The secret as given (an unset environment variable: none), checked with the domain below.
  const secret: Uint8Array | null =
    typeof options.secret === "string"
      ? utf8(options.secret.trim())
      : options.secret instanceof Uint8Array
        ? options.secret
        : null;
  const healthLabel = gate?.label ?? DEFAULT_HEALTH_LABEL;
  // The id Porthole's health check answers with: keyed, so another deployment's answer fails.
  const healthId =
    secret === null || secret.byteLength < 32
      ? ""
      : base64url(hmacSha256(secret, utf8("porthole/health"))).slice(0, 22);
  const appReserved = reservedLabels(options.reserved);

  let domain: ContentDomainInfo | null = null;
  let server: PortholeServer | null = null;
  let view: ContentHealthView = { state: "off" };
  let configs: Readonly<Record<string, PortholeConfig>> = {};

  try {
    domain =
      options.domain !== null && typeof options.domain === "object"
        ? options.domain
        : contentDomain(options.domain, { appOrigins: options.appOrigins });
    if (domain !== null) {
      // Said plainly where it's missing, as where it's short (P074).
      if (secret === null) {
        throw new TypeError(
          "createContentHost needs a secret: at least 32 random bytes (set PORTHOLE_SECRET; npx porthole secret makes one)",
        );
      }
      if (secret.byteLength < 32) {
        throw new TypeError(
          "The secret must be at least 32 random bytes (set PORTHOLE_SECRET; npx porthole secret makes one)",
        );
      }
      if (options.entry !== undefined && options.name?.scopeOf === undefined) {
        throw new TypeError(
          "Redirect entry needs a naming that says which scope a label names (prefixedName)",
        );
      }
      const displays = options.displays;
      configs =
        options.configs === undefined
          ? (displays?.served(domain.source) ??
            (() => {
              throw new TypeError(displays?.problem(domain.source) ?? "No configs");
            })())
          : typeof options.configs === "function"
            ? options.configs(domain.source)
            : options.configs;
      server = createServer({
        content: serverDomain(domain, {
          ...(options.name === undefined ? {} : { name: options.name }),
          reserved: (label) => appReserved(label) || (gate !== undefined && label === healthLabel),
        }),
        secret,
        hostOrigins: options.appOrigins,
        configs,
        ...(options.source === undefined ? {} : { artifacts: { get: options.source } }),
        ...(options.tickets === undefined ? {} : { tickets: options.tickets }),
        ...(options.upstream === undefined ? {} : { upstream: options.upstream }),
        ...(options.entry === undefined
          ? {}
          : {
              entry: {
                authorizeUrl,
                // Whether a clean address names anything, before a browser is sent away (P070).
                named: async (label: string, path: string, request: Request) => {
                  const scope = options.name?.scopeOf?.(label) ?? null;
                  const at = options.entry?.at;
                  return (
                    scope !== null &&
                    at !== undefined &&
                    (await at(scope, path, null, request)) != null
                  );
                },
              },
            }),
        ...(options.authorize === undefined
          ? {}
          : {
              authorize: {
                check: options.authorize,
                ...(options.authorizeTtlSeconds === undefined
                  ? {}
                  : { ttlSeconds: options.authorizeTtlSeconds }),
              },
            }),
      });
      view = gate === undefined ? { state: "healthy" } : { state: "checking" };
    }
  } catch (error) {
    // Porthole never serves settings it refuses. Without the fallback, the app can't start so;
    // with it, they are a lasting "unhealthy: misconfigured", told once.
    if (gate === undefined) {
      throw error;
    }
    const code = error instanceof ContentDomainError ? error.code : "refused";
    const reason = error instanceof Error ? error.message : String(error);
    server = null;
    view = { state: "unhealthy", reason: `misconfigured: ${reason}`, misconfigured: true };
    log({ evt: "porthole.content.misconfigured", code, reason });
  }

  const served = (): boolean => server !== null && view.state === "healthy";
  // onServedChange: once per flip of served(), the first decision included.
  let toldServed: boolean | null = null;
  const tellServed = () => {
    const now = served();
    if (now !== toldServed && view.state !== "checking") {
      toldServed = now;
      try {
        gate?.onServedChange?.(now);
      } catch {
        // The app's listener failing changes nothing here.
      }
    }
  };

  // The health gate: one check at a time, again after a minute while unhealthy, ten while healthy.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<ContentHealthView> | null = null;
  let closed = false;
  let started = false;
  const schedule = () => {
    if (closed || gate === undefined || view.misconfigured === true || domain === null) {
      return;
    }
    timer = setTimeout(
      () => void check(),
      view.state === "healthy" ? HEALTHY_EVERY_MS : UNHEALTHY_EVERY_MS,
    );
    (timer as { unref?: () => void }).unref?.();
  };
  const probe = async (): Promise<string | null> => {
    if (domain === null) {
      return "no content domain";
    }
    const host = `${healthLabel}.${domain.domain}`;
    try {
      const answer = await (gate?.probe ?? fetchProbe)(
        `${domain.originOf(healthLabel)}${HEALTH_PATH}`,
        gate?.timeoutMs ?? PROBE_TIMEOUT_MS,
      );
      if (answer.status !== 200) {
        return `${host} answered ${answer.status}, not Porthole's health check`;
      }
      let said: unknown = null;
      try {
        said = JSON.parse(answer.body);
      } catch {
        said = null;
      }
      if (!isRecord(said) || said.porthole !== "content-domain") {
        return `${host} is answered by something else`;
      }
      return said.id === healthId ? null : `${host} is answered by another deployment`;
    } catch (error) {
      return `${host}: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const check = async (): Promise<ContentHealthView> => {
    if (gate === undefined || domain === null || view.misconfigured === true) {
      return view;
    }
    running ??= (async () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const reason = await probe();
      const before = view;
      view =
        reason === null
          ? { state: "healthy", checkedAt: Date.now() }
          : { state: "unhealthy", reason, checkedAt: Date.now() };
      if (before.state !== view.state || before.reason !== view.reason) {
        log(
          reason === null
            ? { evt: "porthole.content.healthy" }
            : { evt: "porthole.content.unhealthy", reason },
        );
      }
      if (before.state !== view.state) {
        try {
          gate.onChange?.(view);
        } catch {
          // The app's listener failing changes nothing here.
        }
      }
      tellServed();
      running = null;
      schedule();
      return view;
    })();
    return running;
  };

  // Issues per key per minute, in this process.
  const issued = new Map<string, number[]>();
  const withinRate = (key: string): boolean => {
    const limit = options.rateLimit;
    if (limit === undefined) {
      return true;
    }
    const at = Date.now();
    const recent = (issued.get(key) ?? []).filter((time) => at - time < 60_000);
    if (recent.length >= limit.perMinute) {
      issued.set(key, recent);
      return false;
    }
    recent.push(at);
    issued.set(key, recent);
    if (issued.size > 50_000) {
      issued.clear();
    }
    return true;
  };

  /** The content domain's label for a request, or null: the app's host, or a label it reserved. */
  const routeOf = (request: Request): { readonly url: URL; readonly label: string } | null => {
    if (domain === null) {
      return null;
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    const header = request.headers.get("host");
    const byUrl = domain.isContentHost(url.hostname);
    const byHeader = header !== null && domain.isContentHost(header);
    if (!byUrl && !byHeader) {
      return null;
    }
    const label =
      (byUrl ? domain.labelOf(url.hostname) : header === null ? null : domain.labelOf(header)) ??
      "";
    const top = label.split(".").at(-1) ?? "";
    return top !== "" && appReserved(top) ? null : { url, label };
  };

  // The viewer handoff (P072): a key Porthole signs, naming the app's viewer until a time, in a
  // cookie only the prefix's routes get. Never the app's own credential.
  // None where the secret can't sign (then nothing is served, and no handoff made or taken).
  const handoffKey =
    secret === null || secret.byteLength < 32 ? null : hmacSha256(secret, utf8("porthole/handoff"));
  const secureApp = (options.appOrigins[0] ?? "").startsWith("https:");
  const handoffName = secureApp ? "__Secure-porthole-handoff" : "porthole-handoff";
  const handoffCookie = (value: string, maxAge: number): string =>
    [
      `${handoffName}=${value}`,
      `Path=${prefix}`,
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
      ...(secureApp ? ["Secure"] : []),
    ].join("; ");
  const signHandoff = (key: Uint8Array, id: string, until: number): string => {
    const payload = base64url(utf8(JSON.stringify({ h: 1, v: id, x: until })));
    return `${payload}.${base64url(hmacSha256(key, utf8(payload)))}`;
  };
  /** The viewer a request's handoff cookie names, if it is good. */
  const handedOver = async (request: Request): Promise<V | null> => {
    const handoff = options.entry?.handoff;
    if (handoff === undefined || handoffKey === null) {
      return null;
    }
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const at = part.indexOf("=");
      if (at < 0 || part.slice(0, at).trim() !== handoffName) {
        continue;
      }
      const [payload = "", mac = "", ...rest] = part
        .slice(at + 1)
        .trim()
        .split(".");
      const given = fromBase64url(mac);
      if (
        rest.length > 0 ||
        given === null ||
        !timingSafeEqual(given, hmacSha256(handoffKey, utf8(payload)))
      ) {
        continue;
      }
      const bytes = fromBase64url(payload);
      let said: unknown = null;
      try {
        said = bytes === null ? null : JSON.parse(fromUtf8(bytes));
      } catch {
        said = null;
      }
      if (
        isRecord(said) &&
        said.h === 1 &&
        typeof said.v === "string" &&
        typeof said.x === "number" &&
        said.x > Date.now()
      ) {
        return handoff.viewer(said.v, request);
      }
    }
    return null;
  };
  /**
   * Where the person comes back after signing in: the authorize route as the app is reached
   * (`authorizeUrl`'s origin and path), with this request's query (its state). Never the request's
   * own URL, whose origin behind a TLS edge or a dev proxy isn't the app's (P074).
   */
  const returnOf = (request: Request): string => {
    const back = new URL(authorizeUrl);
    back.search = new URL(request.url).search;
    return back.href;
  };
  /** The app's sign-in: its own `signIn`, or its single-page route with `next`. */
  const signInWith = async (
    entry: EntryOptions<V>,
    request: Request,
    context: EntryContext,
  ): Promise<Response> => {
    const returnTo = returnOf(request);
    if (entry.signIn !== undefined) {
      return entry.signIn(returnTo, request, context);
    }
    const route = entry.spa?.route ?? "/";
    const to = new URL(route, new URL(authorizeUrl).origin);
    to.searchParams.set("next", returnTo);
    return new Response(null, {
      status: 303,
      headers: { location: to.href, "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  };

  const host: ContentHost<V> = {
    get domain() {
      return domain;
    },
    get server() {
      return server;
    },
    frameSources:
      server === null || domain === null
        ? []
        : [
            ...embedderFrameSourcesOf(Object.values(configs)),
            // A frame on a clean address goes by the authorize route (only that path).
            ...(options.entry === undefined ? [] : [authorizeSource(authorizeUrl)]),
          ],

    owns: (request) => routeOf(request) !== null,

    async fetch(request) {
      const route = routeOf(request);
      if (route === null) {
        return null;
      }
      const { url, label } = route;
      if (server === null) {
        return plain(503, "Content is unavailable.");
      }
      if (gate !== undefined && label === healthLabel) {
        return url.pathname === HEALTH_PATH && request.method.toUpperCase() === "GET"
          ? json(200, { porthole: "content-domain", id: healthId })
          : plain(404, "Not found.");
      }
      return (await server.handle(request)) ?? plain(404, "Not found.");
    },

    issue(viewerOf) {
      return async (request) => {
        if (request.method.toUpperCase() !== "POST") {
          return refusal(405, "method", "POST { instance } here");
        }
        if (!served() || server === null) {
          return refusal(
            503,
            "not-served",
            domain === null && view.misconfigured !== true
              ? "This app serves no content frames"
              : `Content frames aren't served now: ${view.reason ?? "the content domain is checking"}`,
          );
        }
        let viewer: V | null;
        try {
          viewer = await viewerOf(request);
        } catch {
          return refusal(500, "failed", "The app couldn't tell who is asking");
        }
        const key =
          options.rateLimit?.key?.(request, viewer) ??
          (viewer === null
            ? `address:${request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? ""}`
            : `viewer:${JSON.stringify(viewer)}`);
        if (!withinRate(key)) {
          return refusal(429, "rate-limited", "Too many frames asked for: try again in a minute");
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return refusal(400, "bad-json", "The body is JSON: { instance }");
        }
        const proposal = isRecord(body) ? body.instance : undefined;
        if (
          !isRecord(proposal) ||
          typeof proposal.scope !== "string" ||
          !isRecord(proposal.document) ||
          typeof proposal.document.kind !== "string"
        ) {
          return refusal(400, "bad-request", "The body is { instance: { scope, document } }");
        }
        try {
          const instance = await options.instance(
            proposal as unknown as InstanceRef,
            viewer,
            request,
          );
          if (instance === null) {
            return refusal(404, "not-found", "There is nothing to show for that instance");
          }
          const grant = await options.access(instance, viewer, request);
          if (grant === null) {
            return viewer === null
              ? refusal(401, "unauthenticated", "Sign in to see this")
              : refusal(403, "forbidden", "You can't see this");
          }
          let location: FrameLocation;
          try {
            location = await server.issue(instance, grant);
          } catch (error) {
            return refusal(409, "refused", error instanceof Error ? error.message : String(error));
          }
          // The clean address, where the app says the instance's path (P072, P074).
          let link: string | null = null;
          try {
            const path = (await options.entry?.pathOf?.(instance, request)) ?? null;
            link = path === null ? null : server.urlOf(instance.scope, path);
          } catch {
            link = null;
          }
          return json(201, link === null ? location : { ...location, link });
        } catch {
          return refusal(500, "failed", "The app's policy failed");
        }
      };
    },

    meta: () => ({
      served: served(),
      contentSource: domain?.source ?? null,
      health: gate === undefined ? null : view,
    }),

    prefix,

    clientMeta: () => ({
      served: served(),
      contentSource: domain?.source ?? null,
      frameSources: host.frameSources,
      health:
        gate === undefined
          ? null
          : { state: view.state, ...(view.reason === undefined ? {} : { reason: view.reason }) },
    }),

    routes(viewerOf) {
      const issue = host.issue(viewerOf);
      const authorize = host.authorize(viewerOf);
      const handoff = host.handoff(viewerOf);
      return async (request) => {
        let pathname: string;
        try {
          pathname = new URL(request.url).pathname;
        } catch {
          return null;
        }
        if (!pathname.startsWith(`${prefix}/`)) {
          return null;
        }
        const method = request.method.toUpperCase();
        switch (pathname.slice(prefix.length)) {
          case "/frames":
            return issue(request);
          case "/authorize":
            return authorize(request);
          case "/meta":
            return method === "GET" || method === "HEAD"
              ? json(200, host.clientMeta())
              : refusal(405, "method", "GET here");
          case "/handoff":
            return handoff(request);
          default:
            return null;
        }
      };
    },

    handoff(viewerOf) {
      return async (request) => {
        const method = request.method.toUpperCase();
        if (method !== "POST" && method !== "DELETE") {
          return refusal(405, "method", "POST (or DELETE) here");
        }
        const handoff = options.entry?.handoff;
        if (handoff === undefined) {
          return refusal(404, "not-found", "This app has no viewer handoff (entry.handoff)");
        }
        // The app's own page only: a request from another site never sets or clears it.
        const origin = request.headers.get("origin");
        const site = request.headers.get("sec-fetch-site");
        if (
          (origin !== null && !options.appOrigins.includes(origin)) ||
          (origin === null && site !== null && site !== "same-origin")
        ) {
          return refusal(403, "cross-site", "Only the app's own page hands its viewer over");
        }
        if (method === "DELETE") {
          return new Response(null, {
            status: 204,
            headers: { "set-cookie": handoffCookie("", 0), "cache-control": "no-store" },
          });
        }
        let viewer: V | null;
        try {
          viewer = await viewerOf(request);
        } catch {
          return refusal(500, "failed", "The app couldn't tell who is asking");
        }
        if (viewer === null) {
          return refusal(401, "unauthenticated", "Sign in first: the handoff names a viewer");
        }
        const id = handoff.id(viewer);
        if (typeof id !== "string" || id.length === 0 || id.length > 512) {
          return refusal(500, "failed", "entry.handoff.id gave no id (1 to 512 characters)");
        }
        if (handoffKey === null) {
          return refusal(503, "unavailable", "The content domain isn't served");
        }
        const key = signHandoff(handoffKey, id, Date.now() + HANDOFF_SECONDS * 1_000);
        return new Response(null, {
          status: 204,
          headers: {
            "set-cookie": handoffCookie(key, HANDOFF_SECONDS),
            "cache-control": "no-store",
          },
        });
      };
    },

    forget(filter = {}) {
      server?.forget(filter);
    },

    urlOf(scope, path = "/") {
      return server === null || !served() ? null : server.urlOf(scope, path);
    },

    authorize(viewerOf) {
      const appPage = (
        status: number,
        title: string,
        detail: string,
        reason: FrameBlockReason,
        method: string,
        link?: { readonly href: string; readonly text: string },
      ) =>
        appStatusPage(
          status,
          title,
          detail,
          options.appOrigins.join(" "),
          reason,
          options.appOrigins,
          link,
          method,
        );
      return async (request) => {
        const method = request.method.toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          return appPage(405, "Not allowed", "Open this address in a browser.", "error", method);
        }
        const entry = options.entry;
        if (entry === undefined || server === null || domain === null || !served()) {
          return appPage(
            503,
            "Content is unavailable",
            "This app isn't serving content now. Try again later.",
            "error",
            method,
          );
        }
        const state = server.entryState(new URL(request.url).searchParams.get("state") ?? "");
        if (state === null) {
          return appPage(400, "This link isn't valid", "Open the address again.", "error", method);
        }
        const dest = request.headers.get("sec-fetch-dest");
        const framed = dest === null ? state.framed : dest !== "document";
        const clean = `${domain.originOf(state.label)}${state.path}`;
        if (state.expired) {
          return appPage(
            401,
            "This took too long",
            "Open the address again.",
            "session",
            method,
            framed ? undefined : { href: clean, text: "Open it again" },
          );
        }
        const scope = options.name?.scopeOf?.(state.label) ?? null;
        let viewer: V | null;
        try {
          viewer = (await viewerOf(request)) ?? (await handedOver(request));
        } catch {
          return appPage(
            500,
            "Something went wrong",
            "The app couldn't tell who is asking.",
            "error",
            method,
          );
        }
        try {
          const instance =
            scope === null
              ? null
              : ((await entry.at(
                  scope,
                  new URL(state.path, "https://x.invalid").pathname,
                  viewer,
                  request,
                )) ?? null);
          const grant = instance === null ? null : await options.access(instance, viewer, request);
          // The address being opened, decoded, for the app's sign-in and refusal pages.
          const context: EntryContext = {
            label: state.label,
            scope,
            path: state.path,
            url: clean,
            instance,
            framed,
          };
          if (instance === null || grant === null) {
            if (viewer === null) {
              // The app's sign-in never shows in a frame: the person opens a tab for it.
              return framed
                ? appPage(
                    401,
                    "Open this in a new tab to sign in",
                    "Signing in doesn't work inside a frame.",
                    "sign-in",
                    method,
                  )
                : await signInWith(entry, request, context);
            }
            const status = instance === null ? 404 : 403;
            const own = framed ? null : await entry.refusal?.(status, request, context);
            if (own !== null && own !== undefined) {
              return own;
            }
            return status === 404
              ? appPage(404, "Not found", "There is nothing here.", "not-found", method)
              : appPage(
                  403,
                  "You can't open this",
                  "You don't have access to it.",
                  "denied",
                  method,
                );
          }
          const key =
            options.rateLimit?.key?.(request, viewer) ??
            (viewer === null ? `entry:${state.label}` : `viewer:${JSON.stringify(viewer)}`);
          if (!withinRate(key)) {
            return appPage(429, "Too many requests", "Try again in a minute.", "error", method);
          }
          let location: string;
          try {
            location = await server.enterBy(state, instance, grant);
          } catch {
            return appPage(
              409,
              "This can't be opened here",
              "Open the address again.",
              "error",
              method,
            );
          }
          return new Response(null, {
            status: 302,
            headers: {
              location,
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          });
        } catch {
          return appPage(500, "Something went wrong", "The app's policy failed.", "error", method);
        }
      };
    },

    access: async (request) => (server === null ? null : server.access(request)),

    start() {
      if (started) {
        return;
      }
      started = true;
      closed = false;
      void check();
    },
    check,
    close() {
      closed = true;
      started = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
  return host;
}
