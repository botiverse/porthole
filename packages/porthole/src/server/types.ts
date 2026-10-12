import type { PortholeConfig } from "../config/schema.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";
import type { Naming } from "./naming.ts";

export interface ContentDomain {
  /**
   * The registrable domain content is served under, used for nothing else
   * (`example-usercontent.com`). Dev and tests: `localhost`, so labels are `<label>.localhost`,
   * which browsers resolve to loopback.
   */
  readonly domain: string;
  /** `http` only for `localhost`. */
  readonly scheme: "https" | "http";
  readonly port?: number;
  /**
   * The label under `domain` a storage scope is served on (P047). Default: 24 base32 characters
   * keyed from the scope with the server's secret (stable, not guessable). A host's own (flat
   * names like `a-<id>`) must return one lowercase DNS label, the same for the same scope, a
   * different one for a different scope, and never a `reserved` one.
   */
  readonly name?: Naming;
  /**
   * Labels something else serves on this domain, so this server never names them and hands their
   * requests back: another server's namespace (`f` for `<instance>.f.<domain>`, where that server
   * answers), or the host's own (`p-*`: its previews). Each entry is a whole label, or a prefix
   * ending in `*`; or a function that says whether a label is reserved. Requests for them, and for
   * the names under them, get null (the host's routes), so a host routes them without wrapping
   * `handle`. Labels nothing serves need no entry: they get this server's 404 (P070).
   */
  readonly reserved?: readonly string[] | ((label: string) => boolean);
}

/**
 * Who may open an instance, decided by the host before it calls `issue`: a viewer the host
 * knows, or (a public link) nobody in particular. Porthole never interprets either: identity and
 * authorization policy are the host's (P050).
 */
export type Grant = (
  | {
      /** The host's id for the viewer: recorded with the ticket, never shown to content. */
      readonly viewer: string;
      readonly anonymous?: never;
    }
  | {
      /**
       * A public link: no viewer (P046). Only for documents (a shell, an artifact version, the
       * sandbox proxy), never for a url-mode app.
       */
      readonly anonymous: true;
      readonly viewer?: never;
    }
) & {
  /**
   * The host's own opaque claim, carried in the ticket and the session cookie and handed back to
   * `authorize` on every request (a session id, a share id). At most 512 characters.
   */
  readonly subject?: string;
  /** How long the ticket is good for, seconds (default 60). */
  readonly ttlSeconds?: number;
  /**
   * How long the cookie the ticket buys stays good, seconds (default 3600): what a reload, and a
   * url-mode app's every request, rides on.
   */
  readonly sessionSeconds?: number;
};

export interface TicketRecord {
  readonly instance: InstanceRef;
  /** The grant's viewer; "" for an anonymous grant. */
  readonly viewer: string;
  readonly anonymous?: boolean;
  readonly subject?: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /** The grant's `sessionSeconds`, if it set one. */
  readonly sessionSeconds?: number;
  /**
   * An entry code's (P068): the clean path it returns to, and the nonce of the browser that asked
   * (its cookie must come with the code). A ticket from `issue` has none.
   */
  readonly entry?: { readonly path: string; readonly nonce: string };
}

/** Where tickets live between `issue` and their one use. Default: in memory (one process). */
export interface TicketStore {
  put(id: string, record: TicketRecord): Promise<void>;
  /** Returns the ticket once and never again (atomically), or null if unknown or expired. */
  take(id: string): Promise<TicketRecord | null>;
}

/** Stored pages (artifact mode). Versions are immutable: a new page is a new version. */
export interface ArtifactStore {
  get(id: string, version: string): Promise<{ readonly html: string } | null>;
}

/** What a request's cookie lets in: one instance, for one viewer, on one origin, until a time. */
export interface Access {
  readonly instance: InstanceRef;
  /** The grant's viewer; "" for an anonymous one. */
  readonly viewer: string;
  readonly anonymous?: boolean;
  /** The grant's opaque subject, if it had one. */
  readonly subject?: string;
  /** The content origin the access is for. */
  readonly origin: string;
  /** When the cookie stops being good, epoch milliseconds. */
  readonly expiresAt: number;
}

/**
 * Answers a url-mode app's request once `/server` has checked its access: the host's way to the
 * running app (a proxy to a dev server, say; `proxyTo` is one). The request no longer carries
 * Porthole's cookie; the answer gets `frame-ancestors` added, and loses any cookie named as ours.
 */
export type Upstream = (request: Request, access: Access) => Response | Promise<Response>;

/** What `authorize` is asked about: a request the cookie (or ticket) let in. */
export interface AuthorizeRequest {
  readonly scope: string;
  readonly instance: InstanceRef;
  readonly viewer: string;
  readonly anonymous: boolean;
  readonly subject?: string;
  /** The request itself (its path, method; never its Porthole cookie's value). */
  readonly request: Request;
}

/** The host's answer: let it in, or not (with a short reason code for the host's own UI). */
export type AuthorizeAnswer =
  | { readonly allow: true }
  | {
      readonly allow: false;
      /** A short code (`revoked`, `left-workspace`): lowercase letters, digits and dashes. */
      readonly code?: string;
    };

/**
 * The host's check on every request its cookie lets in (P050): revocation, membership,
 * liveness. Porthole calls it after the cookie (or ticket) verifies and before anything of the
 * content is served; a deny is a 403 page that tells the host why (`blocked: denied`).
 */
export interface Authorizer {
  check(request: AuthorizeRequest): AuthorizeAnswer | Promise<AuthorizeAnswer>;
  /**
   * How long an answer may be reused for the same session and scope, seconds. Default 0: asked
   * on every request. A host opts into a short time for apps with many requests.
   */
  readonly ttlSeconds?: number;
}

export interface ServerOptions {
  readonly content: ContentDomain;
  /** At least 32 random bytes: keys the labels and signs tickets and cookies. */
  readonly secret: Uint8Array;
  /** The host origins that may embed content (`frame-ancestors`) and talk to a served shell. */
  readonly hostOrigins: readonly string[];
  /**
   * The configs a served shell or page is served under, by the name a `ServedDocument` gives
   * (an artifact defaults to `artifact`, the MCP Apps sandbox proxy to `mcpApp`).
   */
  readonly configs: Readonly<Record<string, PortholeConfig>>;
  readonly artifacts?: ArtifactStore;
  readonly tickets?: TicketStore;
  /** Url mode: where an external instance's requests go once let in. Absent: nothing serves them. */
  readonly upstream?: Upstream;
  /** The host's per-request check (P050). Absent: a good cookie is enough until it ends. */
  readonly authorize?: Authorizer;
  /**
   * Redirect entry (P068): a request on a clean address (`urlOf`) without a cookie for it is sent
   * to the host's authorize route, on a host origin, which decides and sends it back with a
   * one-time code (`enterBy`). Absent: a clean address without a cookie is refused, as before.
   */
  readonly entry?: {
    readonly authorizeUrl: string;
    /**
     * Whether a clean address names anything (P070): asked before sending a browser away, with
     * the address's label and pathname. False: this server's 404, never the authorize route. A
     * naming that says a label's scope (`Naming.scopeOf`) already answers 404 for a label it never
     * makes.
     */
    readonly named?: (label: string, path: string, request: Request) => boolean | Promise<boolean>;
  };
}

/** A redirect entry's state, as the host's authorize route reads it (`PortholeServer.entryState`). */
export interface EntryState {
  /** The label the clean address is on. */
  readonly label: string;
  /** The path (and query) it asked for. */
  readonly path: string;
  /** Whether it was asked from a frame. */
  readonly framed: boolean;
  /** Older than five minutes: start again from the clean address. */
  readonly expired: boolean;
  readonly nonce: string;
}

export interface PortholeServer {
  /**
   * Answers a request for any host under the content domain; null for any other request, which
   * the host's own routes then handle. Web-standard `Request`/`Response`.
   */
  handle(request: Request): Promise<Response | null>;
  /** The origin a storage scope maps to. */
  originFor(scope: string): string;
  /**
   * Mints a one-time ticket for `instance` and returns the URL its frame loads. Call it from the
   * host's own authenticated API, once the host has decided the viewer may see the instance.
   */
  issue(instance: InstanceRef, grant: Grant): Promise<FrameLocation>;
  /**
   * The access a request's cookie carries for a url-mode app on the request's origin, or null
   * (no good cookie, or the host's check denies it): for a host's own WebSocket upgrade path,
   * which a fetch-style handler can't take.
   */
  access(request: Request): Promise<Access | null>;
  /** The frame source every content origin matches (`https://*.example-usercontent.com`). */
  readonly contentSource: string;
  /** A clean address on a scope's origin (P068): what a tab, a link, a bookmark opens. */
  urlOf(scope: string, path?: string): string;
  /** A redirect entry's state, signature checked; null for one this server didn't make. */
  entryState(token: string): EntryState | null;
  /**
   * Once the host decided (its authorize route): a one-time code for `instance`, which must be
   * served on the state's label, and the URL that redeems it there (`/__porthole/entry`).
   */
  enterBy(state: EntryState, instance: InstanceRef, grant: Grant): Promise<string>;
}
