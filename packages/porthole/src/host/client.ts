import type { PortholeConfig } from "../config/schema.ts";
import type { Displays } from "../displays/displays.ts";
import type { FrameLocation, InstanceLocator, InstanceRef } from "../isolation/types.ts";
import { LocateError, locationOf, outcomeOfRefusal, refusalOf, type Resolved } from "./locator.ts";
import type { FrameOutcome } from "./types.ts";

/**
 * The client half of the host kit (P072): what the app's page needs from its server's Porthole
 * routes (`ContentHost.routes`, under `/porthole`): whether frames are served and so which config
 * each kind shows under, frame locations, clean addresses, and (for an app whose page holds a
 * token rather than a cookie) the viewer handoff.
 *
 *   const porthole = portholeClient({ displays });                         // base "/porthole"
 *   const config = porthole.config("page");                                // null until meta is known
 *   createHost(config, { locator: porthole }).mount(box, { …, instance });
 */

/** What `GET <prefix>/meta` answers (`ContentHost.clientMeta`). */
export interface ContentClientMeta {
  readonly served: boolean;
  readonly contentSource: string | null;
  readonly frameSources: readonly string[];
  readonly health: {
    readonly state: "off" | "checking" | "healthy" | "unhealthy";
    readonly reason?: string;
  } | null;
}

export interface PortholeClientOptions<N extends string> {
  readonly displays: Displays<N>;
  /** Where the server's Porthole routes are: a path (`/porthole`) or a URL (a desktop app's). */
  readonly base?: string;
  /** Headers for each request (an `authorization`), or a function giving them now. */
  readonly headers?: HeadersInit | (() => HeadersInit);
  /** Default `same-origin` (the app's own cookies); `include` for a base on another origin. */
  readonly credentials?: RequestCredentials;
  /** Meta the server put in the page, so frames needn't wait for a request. */
  readonly meta?: ContentClientMeta;
  /**
   * Keep the viewer handoff fresh (`entry.handoff`, P072): an app whose page authenticates with
   * a token. Done now, when the page regains focus, and when it becomes visible.
   */
  readonly handoff?: boolean;
  readonly fetch?: typeof fetch;
}

/**
 * Every function is declared `this: void` (P074): each may be passed bare
 * (`useSyncExternalStore(porthole.subscribe, porthole.meta)`), and none reads `this`.
 */
export interface PortholeClient<N extends string = string> extends InstanceLocator {
  readonly displays: Displays<N>;
  /** Locates an instance's frame through `POST <base>/frames` (`InstanceLocator`). */
  locate(this: void, instance: InstanceRef, signal?: AbortSignal): Promise<FrameLocation>;
  /** The meta as last fetched, or null before it is known. */
  meta(this: void): ContentClientMeta | null;
  /** Called when the meta changes (frames served or not). */
  subscribe(this: void, listener: () => void): () => void;
  /** Fetches the meta again. */
  refresh(this: void): Promise<ContentClientMeta | null>;
  /**
   * The config a kind shows under now: served while frames are served, else opaque (a url kind:
   * null). Null until the meta is known, so a frame never starts opaque and then restarts served.
   */
  config(this: void, kind: N): PortholeConfig | null;
  /** The same, for an instance's kind. */
  configFor(this: void, instance: InstanceRef): PortholeConfig | null;
  /**
   * What a clean address names, for this viewer (P125): its instance and an issued location (a
   * door, a ticket) for the caller's own first frame (`oneShot(location, locator)`), or the outcome
   * the frame endpoint answered instead (signed out, denied, not found), with no frame built. A
   * clean address is for a tab: never frame one directly (`checkFrameLocation` refuses it).
   */
  resolve(this: void, address: string, signal?: AbortSignal): Promise<Resolved>;
  /** An instance's clean address (`entry.pathOf` on the server), or null. */
  link(this: void, instance: InstanceRef): Promise<string | null>;
  /** The clean address if already known (from locating the instance), for rendering. */
  knownLink(this: void, instance: InstanceRef): string | null;
  /**
   * Opens an instance's clean address in a new tab: call it in the click (the tab opens at once,
   * then goes to the address).
   */
  openInTab(this: void, instance: InstanceRef): void;
  /** Hands the signed-in viewer to the authorize route (`entry.handoff`); true if it took. */
  handoff(this: void): Promise<boolean>;
  /**
   * `next` if it is this server's authorize route (after a sign-in), or with `{ app: true }` any
   * address on the app's own origin; else null (`entryTarget`).
   */
  entryTarget(this: void, next: unknown, options?: { readonly app?: boolean }): string | null;
  /** Stops refreshing the handoff. */
  close(this: void): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Whether a sign-in's `next` is the app's authorize route (P072): the open-redirect guard a
 * single-page app runs before going on to it. Null for anything else; with `{ app: true }`, also
 * any path or address on the app's own origin (P074), so one check serves a sign-in that comes
 * back to redirect entry or to the app's own pages. Never another origin.
 *
 * The authorize route is `<first app origin><prefix>/authorize` unless the server names another
 * (`entry.authorizeUrl`): `https://app.example.com/porthole/authorize` by default.
 */
export function entryTarget(
  next: unknown,
  authorizeUrl: string,
  options: { readonly app?: boolean } = {},
): string | null {
  if (typeof next !== "string" || next.length > 8_192) {
    return null;
  }
  let target: URL;
  let route: URL;
  try {
    route = new URL(authorizeUrl);
    target = new URL(next, route);
  } catch {
    return null;
  }
  if (
    target.origin === route.origin &&
    target.pathname === route.pathname &&
    target.hash === "" &&
    target.searchParams.has("state")
  ) {
    return target.href;
  }
  // An app path: one leading slash, no backslash (`//evil.example` and `/\evil.example` are
  // other sites to a browser), and still the app's origin once resolved.
  const path = /^\/(?![/\\])/u.test(next) && !next.includes("\\");
  const absolute = /^https?:\/\//iu.test(next);
  return options.app === true && (path || absolute) && target.origin === route.origin
    ? target.href
    : null;
}

export function portholeClient<N extends string>(
  options: PortholeClientOptions<N>,
): PortholeClient<N> {
  const base = (options.base ?? "/porthole").replace(/\/+$/u, "");
  const ask =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const headersNow = (): Headers =>
    new Headers(typeof options.headers === "function" ? options.headers() : options.headers);
  const credentials = options.credentials ?? "same-origin";
  const here = () => (typeof location === "undefined" ? "http://localhost/" : location.href);
  const url = (path: string) => new URL(`${base}${path}`, here()).href;

  let meta: ContentClientMeta | null = options.meta ?? null;
  const listeners = new Set<() => void>();
  const links = new Map<string, string | null>();
  const keyOf = (instance: InstanceRef) => JSON.stringify(instance);

  const set = (next: ContentClientMeta | null) => {
    if (JSON.stringify(next) !== JSON.stringify(meta)) {
      meta = next;
      for (const listener of listeners) {
        listener();
      }
    }
  };
  let refreshing: Promise<ContentClientMeta | null> | null = null;
  const refresh = (): Promise<ContentClientMeta | null> => {
    refreshing ??= (async () => {
      try {
        const answer = await ask(url("/meta"), {
          headers: headersNow(),
          credentials,
          cache: "no-store",
        });
        const data: unknown = answer.ok ? await answer.json() : null;
        if (isRecord(data) && typeof data.served === "boolean") {
          set(data as unknown as ContentClientMeta);
        }
      } catch {
        // Keep what is known; the next refresh tries again.
      } finally {
        refreshing = null;
      }
      return meta;
    })();
    return refreshing;
  };
  if (meta === null) {
    void refresh();
  }

  const configOf = (kind: N | null): PortholeConfig | null => {
    if (meta === null || kind === null) {
      return null;
    }
    if (meta.served && meta.contentSource !== null) {
      const served = options.displays.served(meta.contentSource);
      if (served !== null) {
        return served[kind];
      }
    }
    try {
      return options.displays.opaque(kind);
    } catch {
      // A url kind has no opaque config: not shown while frames aren't served.
      return null;
    }
  };

  const askFrames = async (body: Record<string, unknown>, signal?: AbortSignal) => {
    const headers = headersNow();
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    const answer = await ask(url("/frames"), {
      method: "POST",
      headers,
      credentials,
      redirect: "error",
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    const data: unknown = await answer.json().catch(() => null);
    if (!answer.ok) {
      const refused = refusalOf(answer, data);
      if (refused.code === "not-served") {
        void refresh();
      }
      throw refused;
    }
    return { status: answer.status, data };
  };

  /** A location as the frame endpoint gave it: its door (P125) passed on, as it came. */
  const located = (status: number, data: unknown): FrameLocation => {
    const { viewer: _viewer, ...location } = locationOf(status, data);
    return location;
  };

  const issue = async (instance: InstanceRef, signal?: AbortSignal): Promise<FrameLocation> => {
    const key = keyOf(instance);
    const { status, data } = await askFrames({ instance }, signal);
    const location = located(status, data);
    links.set(key, isRecord(data) && typeof data.link === "string" ? data.link : null);
    return location;
  };

  const resolve = async (address: string, signal?: AbortSignal): Promise<Resolved> => {
    let answer: { readonly status: number; readonly data: unknown };
    try {
      answer = await askFrames({ address }, signal);
    } catch (error) {
      // Signed out, denied, not found: the host's own answer, before any frame (P125).
      const outcome = outcomeOfRefusal(error);
      if (outcome !== null) {
        return { outcome };
      }
      throw error;
    }
    const { status, data } = answer;
    const instance = isRecord(data) ? data.instance : undefined;
    if (
      !isRecord(instance) ||
      typeof instance.scope !== "string" ||
      !isRecord(instance.document) ||
      typeof instance.document.kind !== "string"
    ) {
      throw new LocateError(
        "The app's frame endpoint resolved the address to no instance",
        status,
        "bad-location",
      );
    }
    const found = instance as unknown as InstanceRef;
    const location = located(status, data);
    // The location is the caller's, for its own first frame only (`oneShot`): never kept here,
    // where another view of the same instance could take it.
    links.set(keyOf(found), isRecord(data) && typeof data.link === "string" ? data.link : null);
    return { instance: found, location };
  };

  let lastHandoff = 0;
  const handoff = async (): Promise<boolean> => {
    lastHandoff = Date.now();
    try {
      const answer = await ask(url("/handoff"), {
        method: "POST",
        headers: headersNow(),
        credentials,
        cache: "no-store",
      });
      return answer.ok;
    } catch {
      return false;
    }
  };
  // Kept fresh while the page is used: on load, focus and visibility, at most every 30 s.
  const fresh = () => {
    if (
      Date.now() - lastHandoff > 30_000 &&
      (typeof document === "undefined" || document.visibilityState !== "hidden")
    ) {
      void handoff();
    }
  };
  const watching = options.handoff === true && typeof window !== "undefined";
  if (watching) {
    void handoff();
    window.addEventListener("focus", fresh);
    document.addEventListener("visibilitychange", fresh);
  }

  const link = async (instance: InstanceRef): Promise<string | null> => {
    const key = keyOf(instance);
    if (!links.has(key)) {
      try {
        await issue(instance);
      } catch {
        return null;
      }
    }
    return links.get(key) ?? null;
  };

  return {
    displays: options.displays,
    meta: () => meta,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    config: (kind) => configOf(kind),
    configFor: (instance) => configOf(options.displays.kindOf(instance)),
    locate: issue,
    resolve,
    link,
    knownLink: (instance) => links.get(keyOf(instance)) ?? null,
    openInTab: (instance) => {
      // Opened inside the click (a popup blocker lets it), then sent to the address.
      const tab = typeof window === "undefined" ? null : window.open("about:blank", "_blank");
      if (tab === null) {
        return;
      }
      tab.opener = null;
      void (async () => {
        const found = await link(instance);
        if (found === null) {
          tab.close();
        } else {
          tab.location.href = found;
        }
      })();
    },
    handoff,
    entryTarget: (next, given) => entryTarget(next, url("/authorize"), given),
    close: () => {
      if (watching) {
        window.removeEventListener("focus", fresh);
        document.removeEventListener("visibilitychange", fresh);
      }
    },
  };
}

/** What a frame that showed nothing should offer the person, by its outcome (P072). */
export interface FrameFallback {
  /** `needs-tab`: open it in a new tab (the browser keeps no cookie in a frame, sign-in, framing). */
  readonly kind: "needs-tab" | "denied" | "expired" | "failed" | "timeout";
  readonly title: string;
  readonly message: string;
}

/**
 * The fallback for a frame's outcome, worded as Porthole's own pages word it; null when it loaded.
 * `url`: a url-mode app, where a timeout means it couldn't run in a frame.
 */
export function frameFallback(
  outcome: FrameOutcome,
  options: { readonly url?: boolean } = {},
): FrameFallback | null {
  if (outcome.state === "loaded") {
    return null;
  }
  if (outcome.state === "timeout") {
    return options.url === true
      ? {
          kind: "needs-tab",
          title: "Open this in a new tab",
          message: "It didn't load inside the page.",
        }
      : { kind: "timeout", title: "This is taking too long", message: "It didn't finish loading." };
  }
  switch (outcome.reason) {
    case "cookies":
      return {
        kind: "needs-tab",
        title: "Open this in a new tab",
        message: "This browser keeps no sign-in for it inside a frame.",
      };
    case "sign-in":
      return {
        kind: "needs-tab",
        title: "Open this in a new tab to sign in",
        message: "Signing in doesn't work inside a frame.",
      };
    case "framing":
      return {
        kind: "needs-tab",
        title: "Open this in a new tab",
        message: "It can't be shown inside this page.",
      };
    case "denied":
      return {
        kind: "denied",
        title: "You can't open this anymore",
        message: "You no longer have access to it.",
      };
    case "session":
      return { kind: "expired", title: "This has expired", message: "Open it again." };
    case "not-found":
      return { kind: "failed", title: "Not found", message: "There is nothing here." };
    case "upstream":
      return {
        kind: "failed",
        title: "The app didn't answer",
        message: "Its server couldn't be reached.",
      };
    default:
      return { kind: "failed", title: "This couldn't be shown", message: "Something went wrong." };
  }
}
