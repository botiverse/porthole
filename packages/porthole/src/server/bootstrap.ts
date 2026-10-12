import { createContentHost, type ContentHost, type ContentHostOptions } from "./host.ts";

/**
 * The host kit on a runtime that hands each request its settings (Cloudflare Workers' `env`)
 * (P072): one content host per settings object, made on first use. Settings that can't be served
 * fail closed: every request is a plain 503 naming why, told to the log once.
 *
 *   const porthole = contentHostFor((env) => ({ domain: env.CONTENT_DOMAIN, secret: env.PORTHOLE_SECRET, … }));
 *   export default {
 *     async fetch(request, env) {
 *       return (await porthole.fetch(request, env)) ?? app.fetch(request, env);
 *     },
 *   };
 */

export interface ContentHostFor<E extends object, V> {
  /** The content host for these settings; throws, naming why, where they can't be served. */
  host(env: E): ContentHost<V>;
  /**
   * The content domain's answer for a request (`ContentHost.fetch`), or null for the app's own;
   * a plain 503 for every request while the settings can't be served.
   */
  fetch(request: Request, env: E): Promise<Response | null>;
  /** `ContentHost.routes`, for these settings. */
  routes(
    request: Request,
    env: E,
    viewerOf: (request: Request) => V | null | Promise<V | null>,
  ): Promise<Response | null>;
}

/** Why the content host can't be made for some settings. */
class Unservable extends Error {
  override readonly name = "ContentHostUnservable";
}

export function contentHostFor<E extends object, V>(
  build: (env: E) => ContentHostOptions<V>,
  options: { readonly log?: (problem: string) => void } = {},
): ContentHostFor<E, V> {
  const made = new WeakMap<E, ContentHost<V> | Unservable>();
  const hostOf = (env: E): ContentHost<V> => {
    let found = made.get(env);
    if (found === undefined) {
      try {
        found = createContentHost(build(env));
      } catch (error) {
        found = new Unservable(
          `the content domain can't be served: ${error instanceof Error ? error.message : String(error)}`,
        );
        (options.log ?? (() => {}))(found.message);
      }
      made.set(env, found);
    }
    if (found instanceof Unservable) {
      throw found;
    }
    return found;
  };
  const unavailable = (error: Unservable) =>
    new Response(`Unavailable: ${error.message}.`, {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  return {
    host: hostOf,
    async fetch(request, env) {
      let host: ContentHost<V>;
      try {
        host = hostOf(env);
      } catch (error) {
        if (error instanceof Unservable) {
          return unavailable(error);
        }
        throw error;
      }
      return host.fetch(request);
    },
    async routes(request, env, viewerOf) {
      let host: ContentHost<V>;
      try {
        host = hostOf(env);
      } catch (error) {
        if (error instanceof Unservable) {
          return unavailable(error);
        }
        throw error;
      }
      return host.routes(viewerOf)(request);
    },
  };
}
