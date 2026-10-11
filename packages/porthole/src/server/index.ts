/**
 * `@botiverse/porthole/server`: serving content on origins of its own (domain mode, artifact
 * pages, the MCP Apps sandbox proxy, and url mode's access gate). A host's backend mounts it as a
 * fetch-style handler in front of its own routes, for every request whose host is under the
 * content domain:
 *
 *   const porthole = createServer({ content: { domain: "example-usercontent.com", scheme: "https" }, … });
 *   app.all("*", async (c, next) => (await porthole.handle(c.req.raw)) ?? next());   // Hono
 *
 * and calls `issue` from its own authenticated API when a viewer opens served content.
 *
 * Origins: each storage scope gets `<label>.<domain>`, the label keyed from the scope by the
 * secret (stable, DNS-safe, not guessable from the scope). The domain is a registrable domain the
 * host uses for nothing else, so no content origin is ever same-site with the host. Documents go
 * out with their CSP (from the config) plus `frame-ancestors` (the host origins) in headers.
 *
 * Tickets: `issue` mints a one-time ticket for an instance and a viewer, good for a short time; the
 * frame's first request carries it, the content origin takes it (once) and answers with a cookie
 * of that origin only (`__Host-`, `Secure`, `HttpOnly`, `SameSite=None; Partitioned` in a frame),
 * then redirects to the document without the ticket. Private content without a valid cookie gets
 * nothing of the content.
 *
 * Interfaces only for now: built by the served-modes work against these.
 */
import type { PortholeConfig } from "../config/schema.ts";
import { NotBuiltYet } from "../internal/not-built.ts";
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
}

export interface TicketRecord {
  readonly instance: InstanceRef;
  readonly viewer: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
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

export interface ServerOptions {
  readonly content: ContentDomain;
  /** At least 32 random bytes: keys the labels and signs tickets and cookies. */
  readonly secret: Uint8Array;
  /** The host origins that may embed content (`frame-ancestors`) and talk to a served shell. */
  readonly hostOrigins: readonly string[];
  /** The configs a served shell or page is served under, by the name a `ServedDocument` gives. */
  readonly configs: Readonly<Record<string, PortholeConfig>>;
  readonly artifacts?: ArtifactStore;
  readonly tickets?: TicketStore;
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
}

export function createServer(_options: ServerOptions): PortholeServer {
  throw new NotBuiltYet("createServer", "the served-modes work");
}
