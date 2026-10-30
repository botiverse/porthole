import { parseViewer } from "../runtime/levels.ts";
import type { PortholeConfig } from "../config/schema.ts";
import type { FrameLocation, InstanceLocator, InstanceRef } from "../isolation/types.ts";
import type { FrameOutcome } from "./types.ts";

/**
 * The client half of the host kit (P066): a locator that asks the app's issue endpoint
 * (`ContentHost.issue`) for a frame's location, and the choice between served and opaque configs.
 * The client proposes an instance; the server's mapping decides what it means, and the server
 * alone chooses the origin.
 */

/**
 * Why the issue endpoint gave no location: its status and code (`not-served`, `forbidden`, …), and
 * for a refusal the host's own reason code where its answer gave one (`error.reason`, P125).
 */
export class LocateError extends Error {
  readonly status: number;
  readonly code: string;
  /** The host's reason code from the issue answer's `error.reason` (a short lowercase token). */
  readonly reason?: string;

  constructor(message: string, status: number, code: string, reason?: string) {
    super(message);
    this.name = "LocateError";
    this.status = status;
    this.code = code;
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
}

/** A host's reason code, as an outcome's `code` takes it (`FrameOutcome.code`). */
const REASON_CODE = /^[a-z0-9-]{1,40}$/u;

/**
 * What a display shows when the host's own issue endpoint refused it (P125): the host asked before
 * it built any frame, so this is the host's word, never a frame's. Only a refusal maps (401: sign
 * in, 403: denied, with the host's code if its answer gave one, 404: not found); anything else
 * (5xx, a network failure, a malformed answer) is null, the host's own failure (`locate`), never
 * `denied`.
 */
export function outcomeOfRefusal(error: unknown): FrameOutcome | null {
  if (!(error instanceof LocateError)) {
    return null;
  }
  const code =
    error.reason !== undefined && REASON_CODE.test(error.reason) ? { code: error.reason } : {};
  // Only the issue endpoint's own refusal, by its shape (`{ error: { code } }` with the code that
  // goes with its status): a bare 401, 403 or 404 from a router or a firewall in front of it is no
  // answer of the host's, so it stays the host's own failure (`locate`).
  if (error.status === 401 && error.code === "unauthenticated") {
    return { state: "blocked", reason: "sign-in", status: 401 };
  }
  if (error.status === 403 && error.code === "forbidden") {
    return { state: "blocked", reason: "denied", status: 403, ...code };
  }
  if (error.status === 404 && error.code === "not-found") {
    return { state: "blocked", reason: "not-found", status: 404 };
  }
  return null;
}

export interface HttpLocatorOptions {
  /** Headers for each request (an `authorization`), or a function giving them now. */
  readonly headers?: HeadersInit | (() => HeadersInit);
  /** Default `same-origin` (the app's own cookies). */
  readonly credentials?: RequestCredentials;
  /** Content frames aren't served now: refresh what the page knows (`ContentHost.meta`). */
  readonly onNotServed?: () => void;
  readonly fetch?: typeof fetch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A location's door as an issue endpoint answered it (P125): passed on as it came, checked with the
 * location before any frame is made (`checkFrameLocation`); null for none, "bad" for one that
 * isn't `{ url: string }`.
 */
export function doorOf(data: Record<string, unknown>): { readonly url: string } | null | "bad" {
  if (data.door === undefined) {
    return null;
  }
  return isRecord(data.door) && typeof data.door.url === "string" ? { url: data.door.url } : "bad";
}

/** The refusal an issue endpoint answered: its message, status, code and the host's reason. */
export function refusalOf(response: { readonly status: number }, data: unknown): LocateError {
  const error = isRecord(data) && isRecord(data.error) ? data.error : {};
  const code = typeof error.code === "string" ? error.code : "failed";
  const reason =
    typeof error.reason === "string" && REASON_CODE.test(error.reason) ? error.reason : undefined;
  return new LocateError(
    typeof error.message === "string"
      ? error.message
      : `The app's issue endpoint answered ${response.status}`,
    response.status,
    code,
    reason,
  );
}

/** A frame location as an issue endpoint answered it, checked in shape; throws a `LocateError`. */
export function locationOf(status: number, data: unknown): FrameLocation {
  if (
    !isRecord(data) ||
    typeof data.url !== "string" ||
    typeof data.origin !== "string" ||
    (data.reports !== undefined && typeof data.reports !== "boolean")
  ) {
    throw new LocateError(
      "The app's issue endpoint gave no frame location",
      status,
      "bad-location",
    );
  }
  // Who is viewing, as the app's access decided (P087); one that doesn't parse is an error.
  const viewer = data.viewer === undefined ? null : parseViewer(data.viewer);
  if (data.viewer !== undefined && viewer === null) {
    throw new LocateError(
      "The app's issue endpoint named a viewer that isn't one",
      status,
      "bad-location",
    );
  }
  const door = doorOf(data);
  if (door === "bad") {
    throw new LocateError(
      "The app's issue endpoint named a door that isn't one",
      status,
      "bad-location",
    );
  }
  return {
    url: data.url,
    origin: data.origin,
    ...(typeof data.reports === "boolean" ? { reports: data.reports } : {}),
    ...(viewer === null ? {} : { viewer }),
    ...(door === null ? {} : { door }),
  } satisfies FrameLocation;
}

/** POSTs `body` to the app's issue endpoint at `url`: its answer's JSON, or the refusal thrown. */
async function askIssue(
  url: string,
  body: Record<string, unknown>,
  options: HttpLocatorOptions,
  signal?: AbortSignal,
): Promise<{ readonly status: number; readonly data: unknown }> {
  const extra = typeof options.headers === "function" ? options.headers() : options.headers;
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    headers,
    credentials: options.credentials ?? "same-origin",
    redirect: "error",
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const refused = refusalOf(response, data);
    if (refused.code === "not-served") {
      options.onNotServed?.();
    }
    throw refused;
  }
  return { status: response.status, data };
}

/** A locator that POSTs `{ instance }` to the app's issue endpoint at `url`. */
export function httpLocator(url: string, options: HttpLocatorOptions = {}): InstanceLocator {
  return {
    async locate(instance, signal) {
      const { status, data } = await askIssue(url, { instance }, options, signal);
      return locationOf(status, data);
    },
  };
}

/**
 * What a clean address resolves to (P125): its instance and an issued location for it (a ticket,
 * a door), or the outcome the host's issue endpoint answered instead (signed out, denied, not
 * found), before any frame is built. A clean address is for a tab; a frame shows what it names
 * through `issue`.
 */
export type Resolved =
  | { readonly instance: InstanceRef; readonly location: FrameLocation }
  | { readonly outcome: FrameOutcome };

/**
 * A locator whose first call answers `location` (one a `resolve` got), once, and every later one
 * asks `then` (P125): bound to the one display that resolved it, so no other view of the same
 * instance can take its tickets, and every run after the first issues afresh.
 */
export function oneShot(location: FrameLocation, then: InstanceLocator): InstanceLocator {
  let first: FrameLocation | null = location;
  return {
    locate(instance, signal) {
      const given = first;
      first = null;
      return given === null ? then.locate(instance, signal) : Promise.resolve(given);
    },
  };
}

/** Whether a value is an instance as an issue endpoint gives it back: `{ scope, document }`. */
const isInstance = (value: unknown): value is InstanceRef =>
  isRecord(value) &&
  typeof value.scope === "string" &&
  isRecord(value.document) &&
  typeof value.document.kind === "string";

/**
 * Asks the app's issue endpoint at `url` what the clean address `address` names, for this viewer
 * (`{ address }`, P125). A refusal (401, 403, 404) is an outcome; anything else that isn't a
 * location is thrown, the host's own failure.
 */
export async function resolveAddress(
  url: string,
  address: string,
  options: HttpLocatorOptions = {},
  signal?: AbortSignal,
): Promise<Resolved> {
  let answer: { readonly status: number; readonly data: unknown };
  try {
    answer = await askIssue(url, { address }, options, signal);
  } catch (error) {
    const outcome = outcomeOfRefusal(error);
    if (outcome !== null) {
      return { outcome };
    }
    throw error;
  }
  const { status, data } = answer;
  if (!isRecord(data) || !isInstance(data.instance)) {
    throw new LocateError(
      "The app's issue endpoint resolved the address to no instance",
      status,
      "bad-location",
    );
  }
  return { instance: data.instance, location: locationOf(status, data) };
}

/** What the page knows of content (`ContentHost.meta`, as the app's own meta carries it). */
export interface ServedMeta {
  readonly served: boolean;
  readonly contentSource: string | null;
}

/**
 * The configs a page's displays run under: served (from the content source) while content is
 * served, opaque otherwise; null while the page doesn't know yet, so a frame never starts opaque
 * and then restarts served.
 */
export function servedOrOpaque<T extends Readonly<Record<string, PortholeConfig>>>(
  meta: ServedMeta | null | undefined,
  served: (contentSource: string) => T,
  opaque: T,
): { readonly served: boolean; readonly configs: T } | null {
  if (meta === null || meta === undefined) {
    return null;
  }
  return meta.served && meta.contentSource !== null
    ? { served: true, configs: served(meta.contentSource) }
    : { served: false, configs: opaque };
}
