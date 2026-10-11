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
 * Tickets: `issue` mints a one-time ticket for an instance and a viewer, good for a short time;
 * the frame's first request carries it, and the content origin takes it (once). A served document
 * comes back in that same answer, with a cookie of that origin only (`__Host-`, `Secure`,
 * `HttpOnly`, `SameSite=None; Partitioned` in a frame) for what follows; a url-mode app's ticket
 * buys the cookie and redirects to the app's landing path without the ticket (P025). Private
 * content without a valid ticket or cookie gets nothing of the content.
 */
export { createServer } from "./server.ts";
export { memoryTicketStore } from "./tickets.ts";
export { proxyTo, type ProxyOptions } from "./proxy.ts";
export type {
  Access,
  ArtifactStore,
  ContentDomain,
  Grant,
  PortholeServer,
  ServerOptions,
  TicketRecord,
  TicketStore,
  Upstream,
} from "./types.ts";
