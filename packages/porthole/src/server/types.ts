import type { PortholeConfig } from "../config/schema.ts";
import type { FrameLocation, InstanceRef } from "../isolation/types.ts";

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
}

/** Who may open an instance, decided by the host before it calls `issue`. */
export interface Grant {
  /** The host's id for the viewer: recorded with the ticket, never shown to content. */
  readonly viewer: string;
  /** How long the ticket is good for, seconds (default 60). */
  readonly ttlSeconds?: number;
  /**
   * How long the cookie the ticket buys stays good, seconds (default 3600): what a reload, and a
   * url-mode app's every request, rides on.
   */
  readonly sessionSeconds?: number;
}

export interface TicketRecord {
  readonly instance: InstanceRef;
  readonly viewer: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /** The grant's `sessionSeconds`, if it set one. */
  readonly sessionSeconds?: number;
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
  readonly viewer: string;
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
   * The access a request's cookie carries for a url-mode app on the request's origin, or null:
   * for a host's own WebSocket upgrade path, which a fetch-style handler can't take.
   */
  access(request: Request): Promise<Access | null>;
  /** The frame source every content origin matches (`https://*.example-usercontent.com`). */
  readonly contentSource: string;
}
