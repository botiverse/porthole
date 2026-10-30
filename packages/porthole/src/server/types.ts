import type { PortholeConfig } from "../config/schema.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";
import type { ViewerLevel } from "../runtime/levels.ts";
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
  /**
   * The viewer's level on this instance (P087), as the host decided it now: carried in the
   * issue's answer (`FrameLocation.viewer`) to the display's bridge, which checks each runtime
   * method's level against it. Never in the ticket or the cookie, never shown to content but by
   * the `user` capability.
   */
  readonly level?: ViewerLevel;
  /**
   * Who the viewer is to pages that declare `user` (P087): the host's public id for them (whose
   * per-user data, `data/users/<id>`, the page reaches: one path segment, never `me`) and a name.
   * Never `viewer`, unless the host means it to be seen; `pseudonymFor(secret, artifact, person)`
   * gives an id per artifact, so pages can't link a person across artifacts. Only with `level`.
   */
  readonly user?: { readonly id: string; readonly name?: string };
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
  readonly entry?: {
    readonly path: string;
    readonly nonce: string;
    /** A file set's version's own address (P081): the session serves every path under it. */
    readonly base?: string;
    /** Whether that address names this version and no other: its files are immutable there. */
    readonly pinned?: boolean;
  };
  /**
   * A nested page's ticket from its clean address to its shell's own label (P114): the path below
   * its files' base the shell opens (the entry page when absent).
   */
  readonly page?: string;
  /**
   * A door's ticket (P125): `issue` mints one beside the content's, for the same grant and as
   * long, for a display whose frame is on its scope's origin (a served shell, a page that isn't
   * nested, the sandbox proxy). Taken only at the door (`/__porthole/door/<key>`), never at the
   * content's address; the door takes no other.
   */
  readonly door?: true;
}

/** Where tickets live between `issue` and their one use. Default: in memory (one process). */
export interface TicketStore {
  put(id: string, record: TicketRecord): Promise<void>;
  /** Returns the ticket once and never again (atomically), or null if unknown or expired. */
  take(id: string): Promise<TicketRecord | null>;
}

/** One file of a version (P081), as the host stored it when the version was published. */
export interface StoredFile {
  /** Its length, bytes. */
  readonly size: number;
  /** The SHA-256 of its bytes, lowercase hex: its strong ETag. */
  readonly sha256: string;
  /**
   * The type it was published with, for the host's own use (a file list): never served. A file
   * is served with the type Porthole's table gives its extension (`fileTypeOf`), never sniffed.
   */
  readonly type?: string;
}

/** A file's bytes, whole: `/server` cuts the range a request asks for. */
export type FileBody = Uint8Array | ReadableStream<Uint8Array>;

/**
 * A version made of files (P081): a manifest, and the bytes of each file by its path. Paths
 * follow `checkFileSet`'s rules (check them when the version is published); a request is looked
 * up in `files` only, and `read` is asked only for a path in it.
 */
export interface StoredFiles {
  readonly files: Readonly<Record<string, StoredFile>>;
  /** The page the version opens at: one of `files` (default `index.html`). */
  readonly entry?: string;
  /**
   * A single-page app's routes: a navigation whose path finds no file answers the entry, where
   * it would get the nearest `404.html` (default false). Subresources still 404.
   */
  readonly spa?: boolean;
  /** The bytes of a file in `files`; null if they are gone (a 404). */
  read(path: string): Promise<FileBody | null>;
}

/** A stored version: one page (`{ html }`, as in 0.5), or a set of files (P081). */
export type StoredVersion = { readonly html: string } | StoredFiles;

/**
 * One asset of an artifact's library (P089), as the host stored it: served at `/_blob/<id>` on
 * the origin of `scope`, and nowhere else. Its type is Porthole's for `name`'s extension, never
 * the uploader's; it is never served as a page.
 */
export interface StoredAsset {
  /** The storage scope whose origin serves it (the artifact's). */
  readonly scope: string;
  /**
   * The artifact whose library holds it (`ServedDocument`'s `id`, after the review): served only
   * to an access for that artifact, never another one sharing the scope.
   */
  readonly artifact: string;
  /**
   * Whether it may run as code (P089, after the review): a script, stylesheet or WebAssembly an
   * admin uploaded where uploaded code may run (the upload's `trusted`). Any other code-typed
   * asset is served as a download, whatever the config says now; a trusted one too, once the
   * config no longer lets uploaded code run (P103: asked at every request; in bearer mode, every
   * artifact config the server has must).
   */
  readonly trusted?: boolean;
  /** Its file name (its extension types it). */
  readonly name: string;
  readonly size: number;
  /** The SHA-256 of its bytes, lowercase hex: its strong ETag. */
  readonly sha256: string;
  read(): Promise<FileBody | null>;
}

/**
 * Where an artifact's assets are kept (P089): the host's library, by id. Ids are the host's, 32
 * lowercase hex characters made at random (`ASSET_ID`): an asset's address is known only to those
 * shown it; Porthole serves one only on its own scope's origin.
 */
export interface AssetStore {
  /**
   * The asset, for `access` (who asks, for which artifact: the host decides, and its check runs
   * after); null if it isn't there for them. `access` is null only in bearer mode.
   */
  get(id: string, access: Access | null): Promise<StoredAsset | null>;
  /**
   * Bearer mode, an explicit opt-in (after the review): serve an asset to anyone holding its id,
   * with no access and no host check (a public artifact's library). Its id is then a capability:
   * whoever saw it keeps it until the asset is removed.
   */
  readonly bearer?: boolean;
}

/** Stored pages (artifact mode). Versions are immutable: a new page is a new version. */
export interface ArtifactStore {
  get(id: string, version: string): Promise<StoredVersion | null>;
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
  /**
   * Artifacts' asset libraries (P089): `/_blob/<id>` on each content origin, for a request that
   * carries an access to the asset's own artifact (a frame's sealed files' address as its
   * `Referer`, or a session cookie), after the host's check. Absent: `/_blob/` is a clean address
   * like any other.
   */
  readonly assets?: AssetStore;
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
  issue(
    instance: InstanceRef,
    grant: Grant,
    /**
     * Where in the instance its frame opens (P125): a page below a file set's base (what a clean
     * address names, resolved by `issue` given `{ address }`). Default: its entry.
     */
    at?: { readonly page?: string },
  ): Promise<FrameLocation>;
  /**
   * A served display's door answer for a grant the host has already admitted (P126): exactly the
   * Response its door (`DOOR_PATH<key>`, P125) answers once it has taken its own ticket for that
   * instance and grant. The content's address's checks for that grant run here: the host's
   * `authorize` check (`denied`, with its code), the document and its version (`not-found`), a file
   * set's entry being a page and the page `at` names (`not-found`). The answer is `doorResponse`
   * (open) or `doorStatusResponse` (blocked: reason, status, code), with the door's CSP (`sandbox
   * allow-scripts`, `frame-ancestors` the host origins), `no-store`, and no cookie.
   *
   * It is a function, not a route, and it never takes a ticket: it is for a host that signs its own
   * tickets (a content Worker that verifies them itself) and answers its door with it. The caller
   * must have authenticated the request and established the grant itself, as it does before
   * `issue`; Porthole's own door route takes its door ticket and then answers with this. `request`
   * is what `authorize.check` is handed (and gives the method: HEAD has no body, a method other
   * than GET or HEAD is 405); default, a GET of the door on the instance's origin. Throws, as
   * `issue` does, for an instance or grant `issue` would refuse, and for an instance with no door
   * (a nested page, a url-mode app).
   */
  doorAnswer(
    instance: InstanceRef,
    grant: Grant,
    request?: Request,
    /** The page below a file set's base the frame opens at, as `issue`'s `at` (P125). */
    at?: { readonly page?: string },
  ): Promise<Response>;
  /**
   * The access a request's cookie carries for a url-mode app on the request's origin, or null
   * (no good cookie, an `Origin` or `Sec-Fetch-Site` of another origin's (P101), or the host's
   * check denies it): for a host's own WebSocket upgrade path, which a fetch-style handler can't
   * take.
   */
  access(request: Request): Promise<Access | null>;
  /** The frame source every content origin matches (`https://*.example-usercontent.com`). */
  readonly contentSource: string;
  /**
   * Drops cached `authorize.check` answers (`ttlSeconds`): all, or a scope's, or a subject's, so a
   * revocation holds at once (P072).
   */
  forget(filter?: { readonly scope?: string; readonly subject?: string }): void;
  /** A clean address on a scope's origin (P068): what a tab, a link, a bookmark opens. */
  urlOf(scope: string, path?: string): string;
  /** A redirect entry's state, signature checked; null for one this server didn't make. */
  entryState(token: string): EntryState | null;
  /**
   * Once the host decided (its authorize route): a one-time code for `instance`, which must be
   * served on the state's label, and the URL that redeems it there (`/__porthole/entry`). With an
   * `address` (a file set's, P081: `entry.at`'s `base` and `file`), the session it buys serves
   * every path under `base`, and the redeem goes to `base` + `file` when the state's path isn't
   * under it (a "latest" address goes to the version's own).
   */
  enterBy(
    state: EntryState,
    instance: InstanceRef,
    grant: Grant,
    address?: { readonly base: string; readonly file?: string; readonly pinned?: boolean },
  ): Promise<string>;
}
