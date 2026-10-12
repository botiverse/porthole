import type { PortholeConfig } from "../config/schema.ts";
import { embedderFrameSourcesOf } from "../compile/policy.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";
import { base64url, hmacSha256, utf8 } from "./crypto.ts";
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

type Awaitable<T> = T | Promise<T>;

export interface ContentHostOptions<V> {
  /** `content.example.com`, `content.localhost:8790`; empty: content off. Or parsed settings. */
  readonly domain: string | null | undefined | ContentDomainInfo;
  /** The app's own origins: they frame content (`frame-ancestors`) and are checked for clashes. */
  readonly appOrigins: readonly string[];
  /** At least 32 random bytes (or a string of at least 32 bytes). */
  readonly secret: Uint8Array | string;
  readonly tickets?: TicketStore;
  /** The configs content is served under, given the content source (`https://*.<domain>`). */
  readonly configs:
    | Readonly<Record<string, PortholeConfig>>
    | ((source: string) => Readonly<Record<string, PortholeConfig>>);
  /**
   * How a scope is named (`prefixedName("a-")`); default: keyed labels. Redirect entry needs one
   * that says which scope a label names (`prefixedName` does).
   */
  readonly name?: Naming;
  /** Labels the app routes itself (`p-*` previews): `fetch` hands them back. */
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
  readonly log?: (event: ContentHostEvent) => void;
  /**
   * Redirect entry (P068): clean addresses (`urlOf`) that open directly, in a new tab, on a
   * reload, from a bookmark or a link someone with access was sent. Without a cookie, the content
   * origin sends the browser to the app's `authorizeUrl` (`ContentHost.authorize`), which asks
   * `at` and `access` and sends it back with a one-time code.
   */
  readonly entry?: EntryOptions<V>;
}

export interface EntryOptions<V> {
  /** The app's authorize route (`ContentHost.authorize`), an absolute URL on an app origin. */
  readonly authorizeUrl: string;
  /**
   * Policy 1 for a clean address: the instance a scope's path means, or null (404). The path is
   * the address's pathname; its query rides along but never chooses the instance.
   */
  readonly at: (
    scope: string,
    path: string,
    viewer: V | null,
    request: Request,
  ) => Awaitable<InstanceRef | null>;
  /**
   * The app's own sign-in, which comes back to `returnTo` (the authorize URL) once signed in.
   * Only ever on a tab: in a frame, the person is asked to open a new tab instead.
   */
  readonly signIn: (returnTo: string, request: Request) => Awaitable<Response>;
  /** The app's refusal page on a tab (a frame gets Porthole's plain one). Default: Porthole's. */
  readonly refusal?: (status: 403 | 404, request: Request) => Awaitable<Response>;
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
  /** The app's authorize route for redirect entry (`entry.authorizeUrl`), as a fetch handler. */
  authorize(
    viewerOf: (request: Request) => Awaitable<V | null>,
  ): (request: Request) => Promise<Response>;
  /** A url-mode app's access for a WebSocket upgrade (`server.access`), or null. */
  access(request: Request): Promise<Access | null>;
  /** Starts the health gate (after the app listens). */
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
  const log = options.log ?? (() => {});
  const secret = typeof options.secret === "string" ? utf8(options.secret.trim()) : options.secret;
  const healthLabel = gate?.label ?? DEFAULT_HEALTH_LABEL;
  // The id Porthole's health check answers with: keyed, so another deployment's answer fails.
  const healthId = base64url(hmacSha256(secret, utf8("porthole/health"))).slice(0, 22);
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
      if (options.entry !== undefined && options.name?.scopeOf === undefined) {
        throw new TypeError(
          "Redirect entry needs a naming that says which scope a label names (prefixedName)",
        );
      }
      configs =
        typeof options.configs === "function" ? options.configs(domain.source) : options.configs;
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
          : { entry: { authorizeUrl: options.entry.authorizeUrl } }),
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

  // The health gate: one check at a time, again after a minute while unhealthy, ten while healthy.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<ContentHealthView> | null = null;
  let closed = false;
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

  return {
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
            ...(options.entry === undefined ? [] : [authorizeSource(options.entry.authorizeUrl)]),
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
          return json(201, location);
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
          viewer = await viewerOf(request);
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
              : await entry.at(
                  scope,
                  new URL(state.path, "https://x.invalid").pathname,
                  viewer,
                  request,
                );
          const grant = instance === null ? null : await options.access(instance, viewer, request);
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
                : await entry.signIn(request.url, request);
            }
            const status = instance === null ? 404 : 403;
            if (!framed && entry.refusal !== undefined) {
              return await entry.refusal(status, request);
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
      closed = false;
      void check();
    },
    check,
    close() {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
