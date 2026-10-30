import { parseViewer } from "../runtime/levels.ts";
import type { PortholeConfig } from "../config/schema.ts";
import type { FrameLocation, InstanceLocator } from "../isolation/types.ts";

/**
 * The client half of the host kit (P066): a locator that asks the app's issue endpoint
 * (`ContentHost.issue`) for a frame's location, and the choice between served and opaque configs.
 * The client proposes an instance; the server's mapping decides what it means, and the server
 * alone chooses the origin.
 */

/** Why the issue endpoint gave no location: its status and code (`not-served`, `forbidden`, …). */
export class LocateError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "LocateError";
    this.status = status;
    this.code = code;
  }
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

/** A locator that POSTs `{ instance }` to the app's issue endpoint at `url`. */
export function httpLocator(url: string, options: HttpLocatorOptions = {}): InstanceLocator {
  return {
    async locate(instance, signal) {
      const extra = typeof options.headers === "function" ? options.headers() : options.headers;
      const headers = new Headers(extra);
      headers.set("content-type", "application/json");
      headers.set("accept", "application/json");
      const response = await (options.fetch ?? fetch)(url, {
        method: "POST",
        headers,
        credentials: options.credentials ?? "same-origin",
        redirect: "error",
        body: JSON.stringify({ instance }),
        ...(signal === undefined ? {} : { signal }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = isRecord(data) && isRecord(data.error) ? data.error : {};
        const code = typeof error.code === "string" ? error.code : "failed";
        if (code === "not-served") {
          options.onNotServed?.();
        }
        throw new LocateError(
          typeof error.message === "string"
            ? error.message
            : `The app's issue endpoint answered ${response.status}`,
          response.status,
          code,
        );
      }
      if (
        !isRecord(data) ||
        typeof data.url !== "string" ||
        typeof data.origin !== "string" ||
        (data.reports !== undefined && typeof data.reports !== "boolean")
      ) {
        throw new LocateError(
          "The app's issue endpoint gave no frame location",
          response.status,
          "bad-location",
        );
      }
      // Who is viewing, as the app's access decided (P087); one that doesn't parse is an error.
      const viewer = data.viewer === undefined ? null : parseViewer(data.viewer);
      if (data.viewer !== undefined && viewer === null) {
        throw new LocateError(
          "The app's issue endpoint named a viewer that isn't one",
          response.status,
          "bad-location",
        );
      }
      const door = doorOf(data);
      if (door === "bad") {
        throw new LocateError(
          "The app's issue endpoint named a door that isn't one",
          response.status,
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
    },
  };
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
